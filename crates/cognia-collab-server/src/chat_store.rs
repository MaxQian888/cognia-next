use crate::admission::{self, Requirement};
use crate::rollout::FeatureKey;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio_postgres::Row;

use crate::chat::{
    authorize_session_action, SessionAction, SessionEvent, SessionMembership, SessionRole,
    SessionStatus, SharedSession, ToolDetail,
};
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
    pub tool_detail_revision: Option<u64>,
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
    /// Internal durable claim binding; legacy/direct leases have no queue item.
    #[serde(skip)]
    queue_item_id: Option<String>,
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

/// A run's write identity; admission is repeated under each store's resource lock.
pub struct RunWrite<'a> {
    pub org_id: &'a str,
    pub session_id: &'a str,
    pub run_id: &'a str,
    pub token_hash: &'a str,
    pub now: i64,
}

impl<'a> RunWrite<'a> {
    fn event(input: &'a NewSessionEvent, run_id: &'a str, token_hash: &'a str) -> Self {
        Self {
            org_id: &input.org_id,
            session_id: &input.session_id,
            run_id,
            token_hash,
            now: input.now,
        }
    }
}

const LIVE_REQUIREMENTS: &[(FeatureKey, Requirement)] = &[
    (FeatureKey::SharedChatExecution, Requirement::Write),
    (FeatureKey::SharedChat, Requirement::Write),
];

fn run_requirements(input: &NewSessionEvent) -> Vec<(FeatureKey, Requirement)> {
    let mut requirements = vec![(FeatureKey::SharedChatExecution, event_requirement(input))];
    if input.kind.starts_with("message.") {
        requirements.push((FeatureKey::SharedChat, Requirement::Write));
    }
    requirements
}

fn require_tool_detail_manager(member: Option<&SessionMembership>) -> Result<(), StoreError> {
    if member.is_some_and(|m| matches!(m.role, SessionRole::Owner | SessionRole::Maintainer)) {
        Ok(())
    } else {
        Err(StoreError::Policy(
            "tool detail requires owner or maintainer".into(),
        ))
    }
}

fn check_tool_detail(session: &SharedSession, revision: Option<u64>) -> Result<(), StoreError> {
    if revision.is_some_and(|revision| revision < session.tool_detail_revision as u64) {
        return Err(conflict(serde_json::json!({
            "reason":"tool_detail_stale", "toolDetail":session.tool_detail,
            "toolDetailRevision":session.tool_detail_revision,
        })));
    }
    Ok(())
}

#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait ChatStore: Send + Sync {
    /// Validate one ephemeral publication; never inserts or updates a row.
    async fn admit_live_frame(
        &self,
        input: RunWrite<'_>,
        message_id: &str,
        tool_detail_revision: u64,
    ) -> Result<(), StoreError>;
    async fn admit_session_write(&self, org: &str, session: &str) -> Result<(), StoreError>;
    /// Read/drain delivery bypasses rollout while retaining the pinned contract.
    async fn admit_session_contract(&self, org: &str, session: &str) -> Result<(), StoreError>;
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
        tool_detail: Option<(ToolDetail, &str)>,
        operation_id: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<SharedSession, StoreError>;
    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError>;
    async fn effective_member(
        &self, org_id: &str, session_id: &str, user_id: &str,
    ) -> Result<Option<SessionMembership>, StoreError>;
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
        actor_user_id: &str,
        now: i64,
    ) -> Result<SessionMembership, StoreError>;
    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        actor_user_id: &str,
        now: i64,
    ) -> Result<(), StoreError>;
    /// `created_by_user_id` is the authenticated actor, reauthorized under the
    /// session lock; callers must not take that field from a client body.
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
    /// Accept, by id, an invite that names `user_id` as its target (ADR-0207).
    /// An invite naming someone else or nobody, or one already used, revoked
    /// or expired, is [`StoreError::InvitationUnavailable`].
    async fn accept_targeted_invite(
        &self,
        org_id: &str,
        invite_id: &str,
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
    async fn append_session_run_event(
        &self,
        input: NewSessionEvent,
        run_id: &str,
        token_hash: &str,
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
    async fn claim_run_queue(
        &self,
        input: NewChatRunLease,
        item_id: &str,
        takeover: bool,
    ) -> Result<(ChatRunLease, ChatRunQueueItem), StoreError>;
    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
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
        session_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
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
pub(crate) struct MemoryTables {
    pub(crate) sessions: HashMap<String, SharedSession>,
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

/// The part of accepting an invite both lookups share: the invite is still
/// usable and, if it names someone, names this caller.
fn accept_stored_invite(
    tables: &mut crate::store::Tables,
    invite_id: &str,
    user_id: &str,
    now: i64,
) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
    let (invite, _, _) = tables
        .chat.invites
        .get(invite_id)
        .ok_or(StoreError::InvitationUnavailable)?;
    if invite.status != "pending"
        || invite.expires_at <= now
        || invite
            .target_user_id
            .as_ref()
            .is_some_and(|target| target != user_id)
    {
        return Err(StoreError::InvitationUnavailable);
    }
    let session = tables.chat.sessions.get(&invite.session_id).ok_or(StoreError::InvitationUnavailable)?;
    if !can_act(memory_member(tables, &session.org_id, &invite.session_id, &invite.created_by_user_id).as_ref(), SessionAction::ManageMembers) {
        return Err(StoreError::InvitationUnavailable);
    }
    if tables.authorization_audit.iter().any(|event| event.org_id == session.org_id
        && event.action == "org.member.offboarded" && event.target_user_id.as_deref() == Some(user_id)
        && event.created_at >= invite.created_at) {
        return Err(StoreError::InvitationUnavailable);
    }
    admission::memory_chat(tables, &session.org_id, &invite.session_id, FeatureKey::SharedChat, Requirement::Write)?;
    let invite_snapshot = invite.clone();
    let session = tables
        .chat.sessions
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
    let membership = tables
        .chat.memberships
        .entry((invite_snapshot.session_id.clone(), user_id.to_owned()))
        .or_insert(membership)
        .clone();
    let (invite, _, _) = tables
        .chat.invites
        .get_mut(invite_id)
        .ok_or(StoreError::InvitationUnavailable)?;
    invite.status = "accepted".into();
    invite.accepted_by_user_id = Some(user_id.to_owned());
    invite.accepted_at = Some(now);
    Ok((invite.clone(), membership))
}

#[derive(Clone, Default)]
pub struct InMemoryChatStore {
    pub(crate) tables: Arc<RwLock<crate::store::Tables>>,
}

impl InMemoryChatStore {
    pub fn from_store(store: &crate::store::InMemoryStore) -> Self {
        Self { tables: store.tables.clone() }
    }
    pub fn audit_standing(&self, apply: bool, batch_size: usize, now: i64) -> Result<crate::standing_audit::StandingAudit, StoreError> {
        if batch_size == 0 || batch_size > 10_000 {
            return Err(StoreError::Policy("batch-size must be between 1 and 10000".into()));
        }
        let mut keys: Vec<_> = self.tables.read().chat.memberships.keys().cloned().collect();
        keys.sort();
        let mut report = crate::standing_audit::StandingAudit::default();
        for batch in keys.chunks(batch_size) {
            let mut tables = self.tables.write();
            for (session_id, user_id) in batch {
                let Some(member) = tables.chat.memberships.get(&(session_id.clone(), user_id.clone())).filter(|m| !m.guest).cloned() else { continue };
                let org = tables.chat.sessions.get(session_id).ok_or(StoreError::NotFound)?.org_id.clone();
                let effective = memory_member(&tables, &org, session_id, user_id);
                if report.record(&org, &member, effective.as_ref()) && apply
                    && memory_cleanup_member(&mut tables, &org, session_id, user_id, false, false, now) {
                    report.applied += 1;
                }
            }
        }
        Ok(report)
    }

    fn admit_run_write(
        tables: &crate::store::Tables,
        input: &RunWrite<'_>,
        requirements: &[(FeatureKey, Requirement)],
    ) -> Result<(), StoreError> {
        let holder = tables
            .chat
            .leases
            .values()
            .find(|(lease, org, token, _)| {
                org == input.org_id
                    && lease.session_id == input.session_id
                    && lease.run_id == input.run_id
                    && token == input.token_hash
                    && lease.status == "active"
                    && lease.token_expires_at > input.now
                    && lease.heartbeat_expires_at > input.now
            })
            .map(|(lease, _, _, _)| lease.holder_user_id.clone())
            .ok_or(StoreError::NotFound)?;
        if !can_act(
            memory_member(tables, input.org_id, input.session_id, &holder).as_ref(),
            SessionAction::StartRun,
        ) {
            return Err(StoreError::NotFound);
        }
        for &(feature, requirement) in requirements {
            admission::memory_chat(tables, input.org_id, input.session_id, feature, requirement)?;
        }
        Ok(())
    }

    pub fn new() -> Self {
        Self::default()
    }
}

fn conflict(value: impl serde::Serialize) -> StoreError {
    StoreError::Conflict(serde_json::to_value(value).unwrap_or_default())
}

fn event_feature(input: &NewSessionEvent) -> FeatureKey {
    if input.kind.starts_with("run.") || input.kind.starts_with("approval.") {
        FeatureKey::SharedChatExecution
    } else { FeatureKey::SharedChat }
}

fn event_requirement(input: &NewSessionEvent) -> Requirement {
    match input.kind.as_str() {
        "run.completed" | "run.failed" | "run.cancelled" => Requirement::ContractOnly,
        "approval.resolved" if input.payload.get("status").and_then(|v| v.as_str()) == Some("denied") => Requirement::ContractOnly,
        "run.started" => Requirement::New,
        _ => Requirement::Write,
    }
}

fn replay_event(
    existing: SessionEvent,
    input: &NewSessionEvent,
) -> Result<SessionEvent, StoreError> {
    // IDs, timestamps and display labels can be regenerated on retry. The
    // authenticated identity and the immutable operation must remain identical.
    if existing.kind != input.kind
        || existing.actor_kind != input.actor_kind
        || existing.actor_id != input.actor_id
        || existing.payload != input.payload
    {
        return Err(conflict(
            serde_json::json!({"reason":"operation_id_conflict"}),
        ));
    }
    Ok(existing)
}

fn replay_queue(
    existing: ChatRunQueueItem,
    input: &NewChatRunQueueItem,
) -> Result<ChatRunQueueItem, StoreError> {
    let mut payload = input.payload.clone();
    if let Some(payload) = payload.as_object_mut() {
        // The server freezes this boundary on the first enqueue. New events
        // must neither invalidate a retry nor move its execution context.
        payload.remove("contextSequence");
        if let Some(boundary) = existing.payload.get("contextSequence") {
            payload.insert("contextSequence".into(), boundary.clone());
        }
    }
    if existing.requested_by_user_id != input.requested_by_user_id || existing.payload != payload {
        return Err(conflict(
            serde_json::json!({"reason":"operation_id_conflict"}),
        ));
    }
    Ok(existing)
}

pub(crate) fn memory_member(
    tables: &crate::store::Tables, org_id: &str, session_id: &str, user_id: &str,
) -> Option<SessionMembership> {
    let session = tables.chat.sessions.get(session_id).filter(|s| s.org_id == org_id)?;
    let member = tables.chat.memberships.get(&(session_id.to_owned(), user_id.to_owned()))?;
    crate::chat::cap_session_member(member.clone(), memory_standing(tables, org_id, &session.workspace_id, user_id))
}

fn authorize_member_change(
    actor: Option<&SessionMembership>, existing: Option<SessionRole>, requested: SessionRole,
) -> Result<(), StoreError> {
    if !can_act(actor, SessionAction::ManageMembers)
        || !actor.is_some_and(|actor| crate::chat::can_change_member_role(actor.role, existing, requested)) {
        return Err(StoreError::Policy("session member management revoked".into()));
    }
    Ok(())
}

fn authorize_member_removal(
    actor: Option<&SessionMembership>, actor_user_id: &str, target_user_id: &str, existing: Option<SessionRole>,
) -> Result<(), StoreError> {
    // Leaving one's own session remains a read-level operation. Removing
    // somebody else requires current management standing under this lock.
    let action = if actor_user_id == target_user_id { SessionAction::Read } else { SessionAction::ManageMembers };
    if !can_act(actor, action) || (existing == Some(SessionRole::Owner) && !actor.is_some_and(|m| m.role == SessionRole::Owner)) {
        return Err(StoreError::Policy("session member management revoked".into()));
    }
    Ok(())
}

fn grant_role_allowed(
    standing: Option<cognia_tenant_auth::membership::EffectiveWorkspaceAccess>, role: SessionRole, guest: bool,
) -> bool {
    if guest { return matches!(role, SessionRole::Viewer | SessionRole::Member); }
    standing.is_some_and(|standing| crate::chat::session_role_rank(role) <= crate::chat::session_role_rank(crate::chat::session_grant_role_ceiling(standing)))
}

fn memory_standing(
    tables: &crate::store::Tables, org_id: &str, workspace_id: &str, user_id: &str,
) -> Option<cognia_tenant_auth::membership::EffectiveWorkspaceAccess> {
    let org = tables.org_memberships.get(&(org_id.to_owned(), user_id.to_owned())).copied();
    let workspace = tables.workspace_memberships.get(&(org_id.to_owned(), workspace_id.to_owned(), user_id.to_owned())).copied();
    cognia_tenant_auth::membership::resolve_workspace_access(org, workspace)
}

async fn pg_grant_allowed(
    tx: &tokio_postgres::Transaction<'_>, org_id: &str, session_id: &str, user_id: &str, role: SessionRole, guest: bool,
) -> Result<bool, StoreError> {
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};
    if guest { return Ok(grant_role_allowed(None, role, true)); }
    let row = tx.query_opt("SELECT om.role AS org_role, wm.role AS workspace_role FROM chat_sessions s LEFT JOIN org_memberships om ON om.org_id=s.org_id AND om.user_id=$3 LEFT JOIN workspace_memberships wm ON wm.org_id=s.org_id AND wm.workspace_id=s.workspace_id AND wm.user_id=$3 WHERE s.org_id=$1 AND s.id=$2", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
    let org = row.get::<_, Option<String>>("org_role").map(|s| OrgRole::parse(&s).map_err(|e| StoreError::Corrupt(e.to_string()))).transpose()?;
    let workspace = row.get::<_, Option<String>>("workspace_role").map(|s| WorkspaceRole::parse(&s).map_err(|e| StoreError::Corrupt(e.to_string()))).transpose()?;
    Ok(grant_role_allowed(cognia_tenant_auth::membership::resolve_workspace_access(org, workspace), role, false))
}

fn can_act(member: Option<&SessionMembership>, action: SessionAction) -> bool {
    authorize_session_action(member, action, 0).allowed
}

fn revoke_member_work(
    tables: &mut crate::store::Tables,
    org_id: &str,
    session_id: &str,
    user_id: &str,
    now: i64,
) {
    let membership = memory_member(tables, org_id, session_id, user_id);
    crate::session_files::memory_revoke_member_files(tables, org_id, session_id, user_id, membership.as_ref(), now);
    let can_execute = can_act(membership.as_ref(), SessionAction::StartRun);
    let can_post = can_act(membership.as_ref(), SessionAction::Post);
    if !can_execute {
        for (lease, org, _, _) in tables.chat.leases.values_mut() {
            if org == org_id
                && lease.session_id == session_id
                && lease.holder_user_id == user_id
                && matches!(lease.status.as_str(), "active" | "paused")
            {
                lease.status = "failed".into();
                lease.updated_at = now;
            }
        }
    }
    if !can_post {
        for (item, org, _) in tables.chat.queue.values_mut() {
            if org == org_id
                && item.session_id == session_id
                && item.requested_by_user_id == user_id
                && item.status == "queued"
            {
                item.status = "cancelled".into();
            }
        }
    }
}

pub(crate) async fn pg_member(
    tx: &tokio_postgres::Transaction<'_>,
    org_id: &str,
    session_id: &str,
    user_id: &str,
) -> Result<Option<SessionMembership>, StoreError> {
    let row = tx.query_opt(&format!("SELECT {MEMBER_COLUMNS}, om.role AS org_role, wm.role AS workspace_role {MEMBER_JOINS} WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3"), &[&org_id, &session_id, &user_id])
        .await.map_err(|e| StoreError::Database(e.to_string()))?;
    row.as_ref().map(effective_member_from_row).transpose().map(Option::flatten)
}

pub(crate) fn memory_revoke_offboarded_invites(tables: &mut crate::store::Tables, org_id: &str, user_id: &str) {
    for (invite, org, _) in tables.chat.invites.values_mut() {
        if org == org_id && invite.status == "pending"
            && (invite.target_user_id.as_deref() == Some(user_id) || invite.created_by_user_id == user_id) {
            invite.status = "revoked".into();
        }
    }
}

/// Drain concurrent acceptances before offboarding scans memberships. This
/// transaction-wide barrier precedes row locks; session remains the first row
/// locked by acceptance. Later acceptances see the committed audit fence.
pub(crate) async fn pg_lock_invite_standing(tx: &tokio_postgres::Transaction<'_>, org_id: &str, offboarding: bool) -> Result<(), StoreError> {
    let function = if offboarding { "pg_advisory_xact_lock" } else { "pg_advisory_xact_lock_shared" };
    tx.query_one(&format!("SELECT {function}(hashtextextended('cognia.collab.invite-standing:' || $1::text, 0))"), &[&org_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub(crate) fn memory_cleanup_standing(
    tables: &mut crate::store::Tables, org_id: &str, workspace_id: Option<&str>,
    user_id: &str, remove: bool, now: i64,
) -> Vec<String> {
    // Only org offboarding uses remove=true and includes session-only Guests.
    // Workspace changes and legacy audits preserve Guest memberships.
    let mut ids: Vec<_> = tables.chat.sessions.values().filter(|s| {
        s.org_id == org_id && workspace_id.is_none_or(|w| s.workspace_id == w)
            && tables.chat.memberships.get(&(s.id.clone(), user_id.to_owned())).is_some_and(|m| remove || !m.guest)
    }).map(|s| s.id.clone()).collect();
    ids.sort();
    // Untouched when the standing still yields the same membership: no revision
    // bump and no ticket revocation for someone who lost nothing.
    ids.into_iter().filter(|id| memory_cleanup_member(tables, org_id, id, user_id, remove, false, now)).collect()
}

fn memory_cleanup_member(
    tables: &mut crate::store::Tables, org_id: &str, session_id: &str,
    user_id: &str, remove: bool, touch_unchanged: bool, now: i64,
) -> bool {
    let key = (session_id.to_owned(), user_id.to_owned());
    let Some(current) = tables.chat.memberships.get(&key).filter(|m| remove || !m.guest).cloned() else { return false };
    let effective = if remove { None } else { memory_member(tables, org_id, session_id, user_id) };
    if !touch_unchanged && effective.as_ref() == Some(&current) { return false; }
    let removed = effective.is_none();
    match effective {
        Some(mut member) => {
            member.updated_at = now;
            tables.chat.memberships.insert(key, member);
        }
        None => { tables.chat.memberships.remove(&key); }
    }
    if let Some(session) = tables.chat.sessions.get_mut(session_id) {
        session.policy_revision += 1;
        session.updated_at = now;
    }
    revoke_member_work(tables, org_id, session_id, user_id, now);
    if removed {
        for (invite, org, _) in tables.chat.invites.values_mut() {
            if org == org_id && invite.session_id == session_id && invite.created_by_user_id == user_id && invite.status == "pending" {
                invite.status = "revoked".into();
            }
        }
    }
    true
}

pub(crate) async fn pg_cleanup_standing(
    tx: &tokio_postgres::Transaction<'_>, org_id: &str, workspace_id: Option<&str>,
    user_id: &str, remove: bool, now: i64,
) -> Result<Vec<String>, StoreError> {
    // Lock the entire affected set before deleting any membership, always in
    // session-id order, matching invite acceptance and queue claim.
    let rows = tx.query("SELECT s.id FROM chat_sessions s WHERE s.org_id=$1 AND ($2::text IS NULL OR s.workspace_id=$2) AND EXISTS (SELECT 1 FROM chat_session_memberships m WHERE m.org_id=s.org_id AND m.session_id=s.id AND m.user_id=$3 AND ($4 OR NOT m.guest)) ORDER BY s.id FOR UPDATE OF s", &[&org_id,&workspace_id,&user_id,&remove]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    let mut affected = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        // Untouched when the standing still yields the same membership: no
        // revision bump and no ticket revocation for someone who lost nothing.
        if pg_cleanup_member(tx, org_id, &id, user_id, remove, false, now).await? {
            affected.push(id);
        }
    }
    Ok(affected)
}

pub(crate) async fn pg_cleanup_member(
    tx: &tokio_postgres::Transaction<'_>, org_id: &str, session_id: &str,
    user_id: &str, remove: bool, touch_unchanged: bool, now: i64,
) -> Result<bool, StoreError> {
    let row = tx.query_opt(&format!("SELECT {MEMBER_COLUMNS}, om.role AS org_role, wm.role AS workspace_role {MEMBER_JOINS} WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3 AND ($4 OR NOT m.guest)"), &[&org_id,&session_id,&user_id,&remove]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    let Some(row) = row else { return Ok(false) };
    let current = member_from_row(&row)?;
    let effective = if remove { None } else { effective_member_from_row(&row)? };
    if !touch_unchanged && effective.as_ref() == Some(&current) { return Ok(false); }
    match &effective {
        Some(member) => {
            tx.execute("UPDATE chat_session_memberships SET role=$4,approver=$5,updated_at=$6 WHERE org_id=$1 AND session_id=$2 AND user_id=$3", &[&org_id,&session_id,&user_id,&member.role.as_str(),&member.approver,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        }
        None => {
            tx.execute("DELETE FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND user_id=$3", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        }
    }
    tx.execute("UPDATE chat_sessions SET policy_revision=policy_revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2", &[&org_id,&session_id,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    pg_revoke_member_work(tx, org_id, session_id, user_id, effective.as_ref(), now).await?;
    if effective.is_none() {
        tx.execute("UPDATE chat_session_invites SET status='revoked' WHERE org_id=$1 AND session_id=$2 AND created_by_user_id=$3 AND status='pending'", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(true)
}

pub(crate) async fn pg_revoke_member_work(
    tx: &tokio_postgres::Transaction<'_>,
    org_id: &str,
    session_id: &str,
    user_id: &str,
    member: Option<&SessionMembership>,
    now: i64,
) -> Result<(), StoreError> {
    crate::session_files::pg_revoke_member_files(tx, org_id, session_id, user_id, member, now).await?;
    if !can_act(member, SessionAction::StartRun) {
        tx.execute("UPDATE chat_run_leases SET status='failed',updated_at=$4 WHERE org_id=$1 AND session_id=$2 AND holder_user_id=$3 AND status IN ('active','paused')", &[&org_id, &session_id, &user_id, &now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    }
    if !can_act(member, SessionAction::Post) {
        tx.execute("UPDATE chat_run_queue SET status='cancelled' WHERE org_id=$1 AND session_id=$2 AND requested_by_user_id=$3 AND status='queued'", &[&org_id, &session_id, &user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(())
}

#[async_trait]
impl ChatStore for InMemoryChatStore {
    async fn admit_live_frame(
        &self,
        input: RunWrite<'_>,
        message_id: &str,
        tool_detail_revision: u64,
    ) -> Result<(), StoreError> {
        let tables = self.tables.read();
        Self::admit_run_write(&tables, &input, LIVE_REQUIREMENTS)?;
        let session = tables
            .chat
            .sessions
            .get(input.session_id)
            .ok_or(StoreError::NotFound)?;
        check_tool_detail(session, Some(tool_detail_revision))?;
        let events = tables
            .chat
            .events
            .get(input.session_id)
            .ok_or(StoreError::NotFound)?;
        if events.iter().any(|e| {
            e.kind == "message.redacted"
                && e.payload["targetMessageId"].as_str() == Some(message_id)
        }) {
            return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
        }
        Ok(())
    }

    async fn admit_session_contract(&self, org: &str, session: &str) -> Result<(), StoreError> {
        admission::memory_chat(&self.tables.read(), org, session, FeatureKey::SharedChat, Requirement::ContractOnly)
    }
    async fn admit_session_write(&self, org: &str, session: &str) -> Result<(), StoreError> {
        admission::memory_chat(&self.tables.read(), org, session, FeatureKey::SharedChat, Requirement::Write)
    }
    async fn effective_member(
        &self, org_id: &str, session_id: &str, user_id: &str,
    ) -> Result<Option<SessionMembership>, StoreError> {
        Ok(memory_member(&self.tables.read(), org_id, session_id, user_id))
    }

    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError> {
        let mut tables = self.tables.write();
        admission::memory(&tables, FeatureKey::SharedChat, &input.org_id, &input.workspace_id, admission::COLLAB_PROTOCOL_VERSION as i32, Requirement::New)?;
        if let Some(id) = tables
            .chat.operations
            .get(&(input.org_id.clone(), input.operation_id.clone()))
        {
            return tables.chat.sessions.get(id).cloned().ok_or(StoreError::NotFound);
        }
        let session = SharedSession {
            tool_detail: crate::chat::ToolDetail::Summary,
            tool_detail_revision: 0,
            contract_version: crate::admission::COLLAB_PROTOCOL_VERSION as i32,
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
            .chat.operations
            .insert((input.org_id, input.operation_id), session.id.clone());
        tables
            .chat.memberships
            .insert((session.id.clone(), owner.user_id.clone()), owner);
        tables.chat.sessions.insert(session.id.clone(), session.clone());
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
            .chat.sessions
            .values()
            .filter(|session| session.org_id == org_id)
            .filter(|session| workspace_id.is_none_or(|id| session.workspace_id == id))
            .filter(|session| memory_member(&tables, org_id, &session.id, user_id).is_some())
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
        tool_detail: Option<(ToolDetail, &str)>,
        operation_id: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<SharedSession, StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, if status == Some(SessionStatus::Deleting) { Requirement::ContractOnly } else if status == Some(SessionStatus::Active) && tables.chat.sessions.get(session_id).is_some_and(|s| s.status == SessionStatus::Importing) { Requirement::New } else { Requirement::Write })?;
        if let Some((_, actor)) = tool_detail {
            require_tool_detail_manager(
                memory_member(&tables, org_id, session_id, actor).as_ref(),
            )?;
        }
        if let Some(id) = tables
            .chat.operations
            .get(&(org_id.to_owned(), operation_id.to_owned()))
        {
            return tables.chat.sessions.get(id).cloned().ok_or(StoreError::NotFound);
        }
        let session = tables
            .chat.sessions
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
        if let Some((detail, _)) = tool_detail {
            if session.tool_detail != detail {
                session.tool_detail = detail;
                session.tool_detail_revision += 1;
            } else if title.is_none() && status.is_none() {
                return Ok(session.clone());
            }
        }
        session.revision += 1;
        session.policy_revision += 1;
        session.updated_at = now;
        let updated = session.clone();
        tables.chat.operations.insert(
            (org_id.to_owned(), operation_id.to_owned()),
            session_id.to_owned(),
        );
        Ok(updated)
    }

    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly)?;
        if tables
            .chat.sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        tables.chat.sessions.remove(session_id);
        tables
            .chat.memberships
            .retain(|(stored_session, _), _| stored_session != session_id);
        tables.chat.events.remove(session_id);
        tables
            .chat.leases
            .retain(|_, (lease, _, _, _)| lease.session_id != session_id);
        tables
            .chat.invites
            .retain(|_, (invite, _, _)| invite.session_id != session_id);
        tables
            .chat.approvals
            .retain(|_, (approval, _, _)| approval.session_id != session_id);
        tables
            .chat.attachments
            .retain(|_, (attachment, _)| attachment.session_id != session_id);
        tables
            .chat.queue
            .retain(|_, (item, _, _)| item.session_id != session_id);
        tables
            .chat.break_glass
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
            .chat.sessions
            .get(session_id)
            .filter(|session| session.org_id == org_id)
            .cloned()
        else {
            return Ok(None);
        };
        Ok(memory_member(&tables, org_id, session_id, user_id).map(|member| (session, member)))
    }

    async fn admin_session(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<SharedSession, StoreError> {
        self.tables
            .read()
            .chat.sessions
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
            .chat.sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        let mut members: Vec<_> = tables
            .chat.memberships
            .iter()
            .filter(|((session, _), _)| session == session_id)
            .filter_map(|(_, member)| memory_member(&tables, org_id, session_id, &member.user_id))
            .collect();
        members.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        Ok(members)
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
        actor_user_id: &str,
        now: i64,
    ) -> Result<SessionMembership, StoreError> {
        if guest && (matches!(role, SessionRole::Owner | SessionRole::Maintainer) || approver) {
            return Err(StoreError::Corrupt("guest capability ceiling".into()));
        }
        let mut tables = self.tables.write();
        tables
            .chat.sessions
            .get(session_id)
            .filter(|session| session.org_id == org_id && session.workspace_id == workspace_id)
            .ok_or(StoreError::NotFound)?;
        let existing = tables
            .chat.memberships
            .get(&(session_id.to_owned(), user_id.to_owned()));
        let actor = memory_member(&tables, org_id, session_id, actor_user_id);
        authorize_member_change(actor.as_ref(), existing.map(|m| m.role), role)?;
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::Write)?;
        if !grant_role_allowed(memory_standing(&tables, org_id, workspace_id, user_id), role, guest) {
            return Err(StoreError::Policy("session role exceeds grant ceiling".into()));
        }
        if existing.is_some_and(|member| member.role == SessionRole::Owner)
            && role != SessionRole::Owner
            && tables
                .chat.memberships
                .values()
                .filter(|member| {
                    member.session_id == session_id && member.role == SessionRole::Owner
                })
                .count()
                <= 1
        {
            return Err(StoreError::Policy("last owner cannot be demoted".into()));
        }
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
            .chat.memberships
            .insert((session_id.to_owned(), user_id.to_owned()), member.clone());
        let session = tables
            .chat.sessions
            .get_mut(session_id)
            .ok_or(StoreError::NotFound)?;
        session.policy_revision += 1;
        session.updated_at = now;
        revoke_member_work(&mut tables, org_id, session_id, user_id, now);
        Ok(member)
    }

    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        actor_user_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly)?;
        tables
            .chat.sessions
            .get(session_id)
            .filter(|session| session.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        let key = (session_id.to_owned(), user_id.to_owned());
        let removed = tables
            .chat.memberships
            .get(&key)
            .cloned();
        let actor = memory_member(&tables, org_id, session_id, actor_user_id);
        authorize_member_removal(actor.as_ref(), actor_user_id, user_id, removed.as_ref().map(|m| m.role))?;
        let removed = removed.ok_or(StoreError::NotFound)?;
        if removed.role == SessionRole::Owner
            && tables
                .chat.memberships
                .values()
                .filter(|member| {
                    member.session_id == session_id && member.role == SessionRole::Owner
                })
                .count()
                == 1
        {
            return Err(conflict(serde_json::json!({ "reason": "last_owner" })));
        }
        tables.chat.memberships.remove(&key);
        let session = tables
            .chat.sessions
            .get_mut(session_id)
            .filter(|session| session.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        session.policy_revision += 1;
        session.updated_at = now;
        revoke_member_work(&mut tables, org_id, session_id, user_id, now);
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
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let actor = memory_member(&tables, &input.org_id, &input.session_id, &input.created_by_user_id);
        authorize_member_change(actor.as_ref(), None, input.role)?;
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::New)?;
        if let Some(target) = input.target_user_id.as_deref() {
            if !grant_role_allowed(memory_standing(&tables, &input.org_id, &input.workspace_id, target), input.role, input.guest) {
                return Err(StoreError::Policy("session role exceeds grant ceiling".into()));
            }
        }
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
            .chat.invites
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
        for (invite, stored_org, _) in tables.chat.invites.values_mut() {
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
            .chat.invites
            .iter()
            .find(|(_, (_, stored_org, stored_hash))| {
                stored_org == org_id && stored_hash == token_hash
            })
            .map(|(id, _)| id.clone())
            .ok_or(StoreError::InvitationUnavailable)?;
        accept_stored_invite(&mut tables, &invite_id, user_id, now)
    }

    async fn accept_targeted_invite(
        &self,
        org_id: &str,
        invite_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
        let mut tables = self.tables.write();
        let named = tables
            .chat.invites
            .get(invite_id)
            .is_some_and(|(invite, stored_org, _)| {
                stored_org == org_id && invite.target_user_id.as_deref() == Some(user_id)
            });
        if !named {
            return Err(StoreError::InvitationUnavailable);
        }
        accept_stored_invite(&mut tables, invite_id, user_id, now)
    }

    async fn revoke_invite(
        &self,
        org_id: &str,
        session_id: &str,
        invite_id: &str,
    ) -> Result<ChatSessionInvite, StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly)?;
        let (invite, _, _) = tables
            .chat.invites
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
        admission::memory_chat(&tables, &input.org_id, &input.session_id, event_feature(&input), event_requirement(&input))?;
        tables
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let events = tables.chat.events.entry(input.session_id.clone()).or_default();
        if input.kind == "message.corrected" {
            if let Some(target) = input
                .payload
                .get("targetMessageId")
                .and_then(serde_json::Value::as_str)
            {
                if events.iter().any(|event| {
                    event.kind == "message.redacted"
                        && event
                            .payload
                            .get("targetMessageId")
                            .and_then(serde_json::Value::as_str)
                            == Some(target)
                }) {
                    return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
                }
            }
        }
        if let Some(existing) = events
            .iter()
            .find(|event| event.operation_id == input.operation_id)
        {
            return replay_event(existing.clone(), &input);
        }
        if input.kind == "message.created" {
            if let Some(message_id) = input
                .payload
                .get("messageId")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(existing) = events.iter().find(|event| {
                    event.kind == "message.created"
                        && event
                            .payload
                            .get("messageId")
                            .and_then(serde_json::Value::as_str)
                            == Some(message_id)
                }) {
                    return Err(conflict(existing.clone()));
                }
            }
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

    async fn append_session_run_event(
        &self,
        input: NewSessionEvent,
        run_id: &str,
        token_hash: &str,
    ) -> Result<SessionEvent, StoreError> {
        let mut tables = self.tables.write();
        Self::admit_run_write(
            &tables,
            &RunWrite::event(&input, run_id, token_hash),
            &run_requirements(&input),
        )?;
        if matches!(input.kind.as_str(), "message.created" | "message.corrected") {
            let session = tables
                .chat
                .sessions
                .get(&input.session_id)
                .ok_or(StoreError::NotFound)?;
            check_tool_detail(session, input.tool_detail_revision)?;
        }
        tables
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let events = tables.chat.events.entry(input.session_id.clone()).or_default();
        if input.kind == "message.corrected" {
            if let Some(target) = input
                .payload
                .get("targetMessageId")
                .and_then(serde_json::Value::as_str)
            {
                if events.iter().any(|event| {
                    event.kind == "message.redacted"
                        && event
                            .payload
                            .get("targetMessageId")
                            .and_then(serde_json::Value::as_str)
                            == Some(target)
                }) {
                    return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
                }
            }
        }
        if let Some(existing) = events
            .iter()
            .find(|event| event.operation_id == input.operation_id)
        {
            return replay_event(existing.clone(), &input);
        }
        if input.kind == "message.created" {
            if let Some(message_id) = input
                .payload
                .get("messageId")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(existing) = events.iter().find(|event| {
                    event.kind == "message.created"
                        && event
                            .payload
                            .get("messageId")
                            .and_then(serde_json::Value::as_str)
                            == Some(message_id)
                }) {
                    return Err(conflict(existing.clone()));
                }
            }
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
            .chat.sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        Ok(tables
            .chat.events
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
            .chat.sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        Ok(tables
            .chat.events
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
            .chat.sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        tables
            .chat.events
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
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New)?;
        tables
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        if !can_act(
            memory_member(&tables, &input.org_id, &input.session_id, &input.holder_user_id).as_ref(),
            SessionAction::StartRun,
        ) {
            return Err(StoreError::NotFound);
        }
        if let Some((lease, _, token, _)) =
            tables.chat.leases.values().find(|(lease, org, _, operation)| {
                org == &input.org_id
                    && lease.session_id == input.session_id
                    && operation == &input.operation_id
            })
        {
            if token != &input.token_hash
                || lease.run_id != input.run_id
                || lease.holder_user_id != input.holder_user_id
                || lease.holder_device_id != input.holder_device_id
            {
                return Err(StoreError::NotFound);
            }
            return Ok(lease.clone());
        }
        if let Some((lease, _, _, _)) = tables.chat.leases.values_mut().find(|(lease, _, _, _)| {
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
            queue_item_id: None,
            run_id: input.run_id,
            holder_user_id: input.holder_user_id,
            holder_device_id: input.holder_device_id,
            status: "active".into(),
            token_expires_at: input.token_expires_at,
            heartbeat_expires_at: input.heartbeat_expires_at,
            created_at: input.now,
            updated_at: input.now,
        };
        tables.chat.leases.insert(
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

    async fn claim_run_queue(
        &self,
        input: NewChatRunLease,
        item_id: &str,
        takeover: bool,
    ) -> Result<(ChatRunLease, ChatRunQueueItem), StoreError> {
        let mut tables = self.tables.write();
        tables
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        if !can_act(
            memory_member(&tables, &input.org_id, &input.session_id, &input.holder_user_id).as_ref(),
            SessionAction::StartRun,
        ) {
            return Err(StoreError::Policy(
                "queue executor cannot start runs".into(),
            ));
        }
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New)?;
        let item = tables
            .chat.queue
            .get(item_id)
            .filter(|(item, org, _)| org == &input.org_id && item.session_id == input.session_id)
            .map(|(item, _, _)| item.clone())
            .ok_or(StoreError::NotFound)?;
        if !can_act(
            memory_member(&tables, &input.org_id, &input.session_id, &item.requested_by_user_id).as_ref(),
            SessionAction::Post,
        ) {
            if item.status == "queued" {
                tables
                    .chat.queue
                    .get_mut(item_id)
                    .ok_or(StoreError::NotFound)?
                    .0
                    .status = "cancelled".into();
            }
            return Err(StoreError::Policy("queue requester cannot post".into()));
        }
        if let Some((lease, _, token, _)) = tables.chat.leases.values().find(|(lease, org, _, op)| {
            org == &input.org_id
                && lease.session_id == input.session_id
                && op == &input.operation_id
        }) {
            if token != &input.token_hash
                || lease.run_id != input.run_id
                || lease.holder_user_id != input.holder_user_id
                || lease.holder_device_id != input.holder_device_id
            {
                return Err(StoreError::NotFound);
            }
            if lease.queue_item_id.as_deref() != Some(item_id) {
                return Err(conflict(
                    serde_json::json!({"reason":"queue_claim_conflict"}),
                ));
            }
            return Ok((lease.clone(), item));
        }
        // Older rows may predate revocation cleanup. Drop them before finding
        // the FIFO head so a revoked requester cannot stall eligible work.
        let invalid: Vec<_> = tables
            .chat.queue
            .iter()
            .filter(|(_, (item, org, _))| {
                org == &input.org_id
                    && item.session_id == input.session_id
                    && item.status == "queued"
                    && !can_act(
                        memory_member(&tables, &input.org_id, &input.session_id, &item.requested_by_user_id).as_ref(),
                        SessionAction::Post,
                    )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in invalid {
            tables
                .chat.queue
                .get_mut(&id)
                .ok_or(StoreError::NotFound)?
                .0
                .status = "cancelled".into();
        }
        let first = tables
            .chat.queue
            .values()
            .filter(|(item, org, _)| {
                org == &input.org_id
                    && item.session_id == input.session_id
                    && item.status == "queued"
            })
            .min_by_key(|(item, _, _)| item.position);
        if first.is_none_or(|(first, _, _)| first.id != item_id) {
            return Err(StoreError::Conflict(
                serde_json::json!({"reason":"not_queue_head"}),
            ));
        }
        if let Some((lease, _, _, _)) = tables.chat.leases.values().find(|(lease, org, _, _)| {
            org == &input.org_id
                && lease.session_id == input.session_id
                && matches!(lease.status.as_str(), "active" | "paused")
                && lease.heartbeat_expires_at > input.now
        }) {
            return Err(conflict(lease.clone()));
        }
        if let Some((last, _, _, _)) = tables
            .chat.leases
            .values()
            .filter(|(lease, org, _, _)| {
                org == &input.org_id && lease.session_id == input.session_id
            })
            .max_by_key(|(lease, _, _, _)| lease.created_at)
        {
            if matches!(last.status.as_str(), "active" | "paused")
                && last.heartbeat_expires_at > input.now
            {
                return Err(conflict(last.clone()));
            }
            if !takeover
                && (last.status != "released"
                    || last.holder_user_id != input.holder_user_id
                    || last.holder_device_id != input.holder_device_id)
            {
                return Err(StoreError::Conflict(
                    serde_json::json!({"reason":"takeover_required"}),
                ));
            }
        }
        for (lease, org, _, _) in tables.chat.leases.values_mut() {
            if org == &input.org_id
                && lease.session_id == input.session_id
                && matches!(lease.status.as_str(), "active" | "paused")
            {
                lease.status = "expired".into();
                lease.updated_at = input.now;
            }
        }
        let lease = ChatRunLease {
            id: input.id.clone(),
            session_id: input.session_id,
            queue_item_id: Some(item_id.to_owned()),
            run_id: input.run_id,
            holder_user_id: input.holder_user_id,
            holder_device_id: input.holder_device_id,
            status: "active".into(),
            token_expires_at: input.token_expires_at,
            heartbeat_expires_at: input.heartbeat_expires_at,
            created_at: input.now,
            updated_at: input.now,
        };
        tables.chat.leases.insert(
            input.id,
            (
                lease.clone(),
                input.org_id,
                input.token_hash,
                input.operation_id,
            ),
        );
        let item = &mut tables.chat.queue.get_mut(item_id).ok_or(StoreError::NotFound)?.0;
        item.status = "claimed".into();
        Ok((lease, item.clone()))
    }

    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        heartbeat_expires_at: i64,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::Write)?;
        let allowed = can_act(memory_member(&tables, org_id, session_id, holder_user_id).as_ref(), SessionAction::StartRun);
        let (lease, stored_org, stored_token, _) = tables
            .chat.leases
            .get_mut(lease_id)
            .ok_or(StoreError::NotFound)?;
        if stored_org != org_id
            || lease.session_id != session_id
            || lease.holder_user_id != holder_user_id
            || lease.holder_device_id != holder_device_id
            || stored_token != token_hash
        {
            return Err(StoreError::NotFound);
        }
        if !allowed {
            if matches!(lease.status.as_str(), "active" | "paused") {
                lease.status = "failed".into();
                lease.updated_at = now;
            }
            return Err(StoreError::NotFound);
        }
        if lease.status != "active" || lease.token_expires_at <= now || lease.heartbeat_expires_at <= now {
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
        session_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        now: i64,
        status: &str,
    ) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::ContractOnly)?;
        let allowed = can_act(memory_member(&tables, org_id, session_id, holder_user_id).as_ref(), SessionAction::StartRun);
        let (lease, stored_org, stored_token, _) = tables
            .chat.leases
            .get_mut(lease_id)
            .ok_or(StoreError::NotFound)?;
        if stored_org != org_id
            || lease.session_id != session_id
            || lease.holder_user_id != holder_user_id
            || lease.holder_device_id != holder_device_id
            || stored_token != token_hash
        {
            return Err(StoreError::NotFound);
        }
        if !allowed {
            if matches!(lease.status.as_str(), "active" | "paused") {
                lease.status = "failed".into();
                lease.updated_at = now;
            }
            return Err(StoreError::NotFound);
        }
        if !matches!(lease.status.as_str(), "active" | "paused") && lease.status != status {
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
            tables.chat.leases.values_mut().find(|(lease, org, _, _)| {
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
            .chat.leases
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
            .filter(|(lease, _, _, _)| can_act(memory_member(&tables, org_id, session_id, &lease.holder_user_id).as_ref(), SessionAction::StartRun))
            .map(|(lease, _, _, _)| lease.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn enqueue_run_input(
        &self,
        mut input: NewChatRunQueueItem,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut tables = self.tables.write();
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New)?;
        tables
            .chat.sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;

        if let Some((item, _, _)) = tables.chat.queue.values().find(|(item, stored_org, operation)| {
            stored_org == &input.org_id
                && item.session_id == input.session_id
                && operation == &input.operation_id
        }) {
            return replay_queue(item.clone(), &input);
        }
        if !can_act(memory_member(&tables, &input.org_id, &input.session_id, &input.requested_by_user_id).as_ref(), SessionAction::Post) {
            return Err(StoreError::NotFound);
        }
        let boundary = tables
            .chat.events
            .get(&input.session_id)
            .and_then(|events| events.last())
            .map_or(0, |event| event.sequence);
        if let Some(payload) = input.payload.as_object_mut() {
            payload.insert("contextSequence".into(), serde_json::json!(boundary));
        }
        let position = tables
            .chat.queue
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
            .chat.queue
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
            .chat.queue
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
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::ContractOnly)?;
        let (item, stored_org, _) = tables.chat.queue.get_mut(item_id).ok_or(StoreError::NotFound)?;
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
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::ContractOnly)?;
        if let Some((grant, _, _)) = tables
            .chat.break_glass
            .values()
            .find(|(_, org, operation)| org == &input.org_id && operation == &input.operation_id)
        {
            return Ok(grant.clone());
        }
        if !tables
            .chat.sessions
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
            .chat.break_glass
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
            .chat.break_glass
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
        if !can_act(memory_member(&tables, &input.org_id, &input.session_id, &input.requested_by_user_id).as_ref(), SessionAction::StartRun) {
            return Err(StoreError::NotFound);
        }
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::Write)?;
        if let Some((approval, _, _)) = tables
            .chat.approvals
            .values()
            .find(|(_, org, op)| org == &input.org_id && op == &input.operation_id)
        {
            return Ok(approval.clone());
        }
        let holds_run = tables.chat.leases.values().any(|(lease, org, _, _)| {
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
        tables.chat.approvals.insert(
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
        for (approval, stored_org, _) in tables.chat.approvals.values_mut() {
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
            .chat.approvals
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
        let risk = &tables.chat.approvals.get(approval_id).ok_or(StoreError::NotFound)?.0.risk;
        let action = if risk == "high" { SessionAction::ApproveHighRisk } else { SessionAction::ApproveOrdinary };
        if !can_act(memory_member(&tables, org_id, session_id, resolver_user_id).as_ref(), action) {
            return Err(StoreError::NotFound);
        }
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChatExecution, if status == "denied" { Requirement::ContractOnly } else if risk == "high" { Requirement::New } else { Requirement::Write })?;
        let (approval, _, _) = tables
            .chat.approvals
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
        admission::memory_chat(&tables, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::Write)?;
        tables
            .chat.sessions
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
            .chat.attachments
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
            .chat.attachments
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
            .chat.attachments
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
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::Write)?;
        let (attachment, _) = tables
            .chat.attachments
            .get_mut(attachment_id)
            .filter(|(attachment, stored_org)| {
                stored_org == org_id && attachment.session_id == session_id
            })
            .ok_or(StoreError::NotFound)?;
        if attachment.status == "available" && attachment.event_id.as_deref() == event_id {
            return Ok(attachment.clone());
        }
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
        admission::memory_chat(&tables, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly)?;
        let (attachment, _) = tables
            .chat.attachments
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
        tool_detail: match row.get::<_, String>("tool_detail").as_str() {
            "summary" => ToolDetail::Summary,
            "full" => ToolDetail::Full,
            other => return Err(StoreError::Corrupt(format!("unknown tool detail {other}"))),
        },
        tool_detail_revision: row.get("tool_detail_revision"),
        contract_version: row.get("contract_version"),
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

pub(crate) fn member_from_row(row: &Row) -> Result<SessionMembership, StoreError> {
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
        queue_item_id: row.get("queue_item_id"),
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

fn qualified_session_columns() -> String {
    SESSION_COLUMNS
        .split(',')
        .map(|column| format!("s.{}", column.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

const SESSION_COLUMNS: &str = "id, org_id, workspace_id, title, status, created_by_user_id, created_at, updated_at, revision, policy_revision, contract_version, tool_detail, tool_detail_revision";
pub(crate) const MEMBER_JOINS: &str = "FROM chat_session_memberships m JOIN chat_sessions s ON s.org_id=m.org_id AND s.id=m.session_id LEFT JOIN users u ON u.id=m.user_id LEFT JOIN org_memberships om ON om.org_id=s.org_id AND om.user_id=m.user_id LEFT JOIN workspace_memberships wm ON wm.org_id=s.org_id AND wm.workspace_id=s.workspace_id AND wm.user_id=m.user_id";

pub(crate) fn effective_member_from_row(row: &Row) -> Result<Option<SessionMembership>, StoreError> {
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};
    let org = row.get::<_, Option<String>>("org_role").map(|s| OrgRole::parse(&s).map_err(|e| StoreError::Corrupt(e.to_string()))).transpose()?;
    let workspace = row.get::<_, Option<String>>("workspace_role").map(|s| WorkspaceRole::parse(&s).map_err(|e| StoreError::Corrupt(e.to_string()))).transpose()?;
    Ok(crate::chat::cap_session_member(member_from_row(row)?, cognia_tenant_auth::membership::resolve_workspace_access(org, workspace)))
}

pub(crate) const MEMBER_COLUMNS: &str = "m.session_id, m.user_id, m.role, m.approver, m.guest, u.display_name, m.created_at, m.updated_at";
const EVENT_COLUMNS: &str = "id, session_id, sequence, kind, actor_kind, actor_id, actor_label, payload, created_at, operation_id";
const LEASE_COLUMNS: &str = "id, session_id, queue_item_id, run_id, holder_user_id, holder_device_id, status, token_expires_at, heartbeat_expires_at, created_at, updated_at";
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

/// How an invite being accepted is found.
#[derive(Clone, Copy)]
enum InviteKey<'a> {
    /// Whoever holds the token.
    TokenHash(&'a str),
    /// By id, only for the person the invite names.
    TargetedId(&'a str),
}

impl PgStore {
    async fn admit_run_write(
        &self,
        tx: &tokio_postgres::Transaction<'_>,
        input: &RunWrite<'_>,
        requirements: &[(FeatureKey, Requirement)],
    ) -> Result<SharedSession, StoreError> {
        tx.query_opt(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&input.org_id, &input.session_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::NotFound)?;
        let holder: String = tx.query_opt("SELECT holder_user_id FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND run_id=$3 AND token_hash=$4 AND status='active' AND token_expires_at>$5 AND heartbeat_expires_at>$5 FOR UPDATE", &[&input.org_id,&input.session_id,&input.run_id,&input.token_hash,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?.get(0);
        if !can_act(
            pg_member(tx, input.org_id, input.session_id, &holder)
                .await?
                .as_ref(),
            SessionAction::StartRun,
        ) {
            return Err(StoreError::NotFound);
        }
        for &(feature, requirement) in requirements {
            self.admit_chat(tx, input.org_id, input.session_id, feature, requirement)
                .await?;
        }
        let row = tx
            .query_one(
                &format!("SELECT {SESSION_COLUMNS} FROM chat_sessions WHERE org_id=$1 AND id=$2"),
                &[&input.org_id, &input.session_id],
            )
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        session_from_row(&row)
    }

    async fn accept_invite_by(
        &self,
        org_id: &str,
        key: InviteKey<'_>,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
        let (column, value) = match key {
            InviteKey::TokenHash(hash) => ("token_hash", hash),
            InviteKey::TargetedId(id) => ("id", id),
        };
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        pg_lock_invite_standing(&tx, org_id, false).await?;
        // Use the same session-first lock ordering as membership and queue
        // mutations; invitation acceptance must not race revocation.
        tx.query_opt(&format!("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=(SELECT session_id FROM chat_session_invites WHERE org_id=$1 AND {column}=$2) FOR UPDATE"), &[&org_id, &value]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::InvitationUnavailable)?;
        let row = tx.query_opt(&format!("SELECT {INVITE_COLUMNS}, workspace_id FROM chat_session_invites WHERE org_id=$1 AND {column}=$2 FOR UPDATE"), &[&org_id,&value]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::InvitationUnavailable)?;
        let current = invite_from_row(&row)?;
        if matches!(key, InviteKey::TargetedId(_))
            && current.target_user_id.as_deref() != Some(user_id)
        {
            return Err(StoreError::InvitationUnavailable);
        }
        if current.status != "pending"
            || current.expires_at <= now
            || current
                .target_user_id
                .as_ref()
                .is_some_and(|target| target != user_id)
        {
            return Err(StoreError::InvitationUnavailable);
        }
        if !can_act(pg_member(&tx, org_id, &current.session_id, &current.created_by_user_id).await?.as_ref(), SessionAction::ManageMembers) {
            return Err(StoreError::InvitationUnavailable);
        }
        let offboarded: bool = tx.query_one("SELECT EXISTS (SELECT 1 FROM authorization_audit_events WHERE org_id=$1 AND target_user_id=$2 AND action='org.member.offboarded' AND created_at >= $3)", &[&org_id, &user_id, &current.created_at]).await.map_err(|e| StoreError::Database(e.to_string()))?.get(0);
        if offboarded { return Err(StoreError::InvitationUnavailable); }
        self.admit_chat(&tx, org_id, &current.session_id, FeatureKey::SharedChat, Requirement::Write).await?;
        let workspace_id: String = row.get("workspace_id");
        tx.execute("INSERT INTO chat_session_memberships (org_id,workspace_id,session_id,user_id,role,approver,guest,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (session_id,user_id) DO NOTHING", &[&org_id,&workspace_id,&current.session_id,&user_id,&current.role.as_str(),&current.approver,&current.guest,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let invite_row = tx.query_one(&format!("UPDATE chat_session_invites SET status='accepted',accepted_by_user_id=$3,accepted_at=$4 WHERE org_id=$1 AND id=$2 RETURNING {INVITE_COLUMNS}"), &[&org_id,&current.id,&user_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.execute("UPDATE chat_sessions SET policy_revision=policy_revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2", &[&org_id,&current.session_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let member_row = tx.query_one(&format!("SELECT {MEMBER_COLUMNS} FROM chat_session_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3"), &[&org_id,&current.session_id,&user_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok((invite_from_row(&invite_row)?, member_from_row(&member_row)?))
    }
}

#[async_trait]
impl ChatStore for PgStore {
    async fn admit_live_frame(
        &self,
        input: RunWrite<'_>,
        message_id: &str,
        tool_detail_revision: u64,
    ) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, input.org_id).await?;
        let session = self.admit_run_write(&tx, &input, LIVE_REQUIREMENTS).await?;
        check_tool_detail(&session, Some(tool_detail_revision))?;
        if tx.query_opt("SELECT id FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.redacted' AND payload->>'targetMessageId'=$3 LIMIT 1", &[&input.org_id,&input.session_id,&message_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.is_some() {
            return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
        }
        // Dropping this read-only transaction persists nothing.
        Ok(())
    }

    async fn admit_session_contract(&self, org: &str, session: &str) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org).await?;
        self.admit_chat(&tx, org, session, FeatureKey::SharedChat, Requirement::ContractOnly).await
    }
    async fn admit_session_write(&self, org: &str, session: &str) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org).await?;
        self.admit_chat(&tx, org, session, FeatureKey::SharedChat, Requirement::Write).await
    }
    async fn effective_member(
        &self, org_id: &str, session_id: &str, user_id: &str,
    ) -> Result<Option<SessionMembership>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        pg_member(&tx, org_id, session_id, user_id).await
    }

    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        self.admit(&tx, FeatureKey::SharedChat, &input.org_id, &input.workspace_id, admission::COLLAB_PROTOCOL_VERSION as i32, Requirement::New).await?;
        if let Some(row) = tx.query_opt(&format!("SELECT {SESSION_COLUMNS} FROM chat_sessions WHERE org_id = $1 AND created_operation_id = $2"), &[&input.org_id, &input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            return session_from_row(&row);
        }
        let row = tx.query_one(&format!("INSERT INTO chat_sessions (id, org_id, workspace_id, title, status, created_by_user_id, created_at, updated_at, created_operation_id, last_operation_id, contract_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$9) RETURNING {SESSION_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.title,&format!("{:?}", input.status).to_lowercase(),&input.created_by_user_id,&input.now,&input.operation_id,&(admission::COLLAB_PROTOCOL_VERSION as i32)]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("INSERT INTO chat_session_memberships (org_id, workspace_id, session_id, user_id, role, approver, guest, created_at, updated_at) VALUES ($1,$2,$3,$4,'owner',true,false,$5,$5)", &[&input.org_id,&input.workspace_id,&input.id,&input.created_by_user_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        session_from_row(&row)
    }

    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly).await?;
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
        let rows = tx.query(&format!("SELECT {}, {MEMBER_COLUMNS}, om.role AS org_role, wm.role AS workspace_role {MEMBER_JOINS} WHERE m.user_id=$2 AND s.org_id=$1 AND ($3::text IS NULL OR s.workspace_id=$3) ORDER BY s.updated_at DESC", qualified_session_columns()), &[&org_id,&user_id,&workspace_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let mut sessions = Vec::new();
        for row in &rows {
            if effective_member_from_row(row)?.is_some() {
                sessions.push(session_from_row(row)?);
            }
        }
        Ok(sessions)
    }

    async fn patch_session(
        &self,
        org_id: &str,
        session_id: &str,
        title: Option<&str>,
        status: Option<SessionStatus>,
        tool_detail: Option<(ToolDetail, &str)>,
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
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, if status == Some(SessionStatus::Deleting) { Requirement::ContractOnly } else if status == Some(SessionStatus::Active) && existing.get::<_, String>("status") == "importing" { Requirement::New } else { Requirement::Write }).await?;
        if let Some((_, actor)) = tool_detail {
            require_tool_detail_manager(pg_member(&tx, org_id, session_id, actor).await?.as_ref())?;
        }
        if existing.get::<_, String>("last_operation_id") == operation_id {
            return session_from_row(&existing);
        }
        let current = session_from_row(&existing)?;
        if current.revision != base_revision {
            return Err(conflict(current));
        }
        if tool_detail.is_some_and(|(detail, _)| detail == current.tool_detail)
            && title.is_none()
            && status.is_none()
        {
            return Ok(current);
        }
        let detail_text = tool_detail.map(|(detail, _)| detail.as_str());
        let status_text = status.map(|value| format!("{value:?}").to_lowercase());
        let row = tx
            .query_one(
                &format!("UPDATE chat_sessions SET title=COALESCE($3,title),status=COALESCE($4,status),tool_detail_revision=tool_detail_revision+CASE WHEN $7::text IS NOT NULL AND tool_detail<>$7 THEN 1 ELSE 0 END,tool_detail=COALESCE($7,tool_detail),updated_at=$5,revision=revision+1,policy_revision=policy_revision+1,last_operation_id=$6 WHERE org_id=$1 AND id=$2 RETURNING {SESSION_COLUMNS}"),
                &[&org_id, &session_id, &title, &status_text, &now, &operation_id, &detail_text],
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
        let Some(member) = pg_member(&tx, org_id, session_id, user_id).await? else { return Ok(None) };
        Ok(Some((session_from_row(&session_row)?, member)))
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
        let rows = tx.query(&format!("SELECT {MEMBER_COLUMNS}, om.role AS org_role, wm.role AS workspace_role {MEMBER_JOINS} WHERE m.org_id=$1 AND m.session_id=$2 ORDER BY m.user_id"), &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        rows.iter().map(effective_member_from_row).collect::<Result<Vec<_>, _>>().map(|members| members.into_iter().flatten().collect())
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
        actor_user_id: &str,
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
        let actor = pg_member(&tx, org_id, session_id, actor_user_id).await?;
        let existing = previous.as_ref().map(|row| SessionRole::parse(&row.get::<_, String>(0)).ok_or_else(|| StoreError::Corrupt("unknown session role".into()))).transpose()?;
        authorize_member_change(actor.as_ref(), existing, role)?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::Write).await?;
        if !pg_grant_allowed(&tx, org_id, session_id, user_id, role, guest).await? {
            return Err(StoreError::Policy("session role exceeds grant ceiling".into()));
        }
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
        let member = member_from_row(&row)?;
        let effective = pg_member(&tx, org_id, session_id, user_id).await?;
        pg_revoke_member_work(&tx, org_id, session_id, user_id, effective.as_ref(), now).await?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(member)
    }

    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        actor_user_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly).await?;
        tx.query_one(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&org_id, &session_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
        let row=tx.query_opt("SELECT role FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND user_id=$3 FOR UPDATE", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let actor = pg_member(&tx, org_id, session_id, actor_user_id).await?;
        let existing = row.as_ref().map(|row| SessionRole::parse(&row.get::<_, String>(0)).ok_or_else(|| StoreError::Corrupt("unknown session role".into()))).transpose()?;
        authorize_member_removal(actor.as_ref(), actor_user_id, user_id, existing)?;
        let row = row.ok_or(StoreError::NotFound)?;
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
        pg_revoke_member_work(&tx, org_id, session_id, user_id, None, now).await?;
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
        tx.query_opt("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        let actor = pg_member(&tx, &input.org_id, &input.session_id, &input.created_by_user_id).await?;
        authorize_member_change(actor.as_ref(), None, input.role)?;
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::New).await?;
        if let Some(target) = input.target_user_id.as_deref() {
            if !pg_grant_allowed(&tx, &input.org_id, &input.session_id, target, input.role, input.guest).await? {
                return Err(StoreError::Policy("session role exceeds grant ceiling".into()));
            }
        }
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
        self.accept_invite_by(org_id, InviteKey::TokenHash(token_hash), user_id, now)
            .await
    }

    async fn accept_targeted_invite(
        &self,
        org_id: &str,
        invite_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
        self.accept_invite_by(org_id, InviteKey::TargetedId(invite_id), user_id, now)
            .await
    }

    async fn revoke_invite(
        &self,
        org_id: &str,
        session_id: &str,
        invite_id: &str,
    ) -> Result<ChatSessionInvite, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly).await?;
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
        self.admit_chat(&tx, &input.org_id, &input.session_id, event_feature(&input), event_requirement(&input)).await?;
        tx.query_opt(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&input.org_id, &input.session_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::NotFound)?;
        if input.kind == "message.corrected" {
            if let Some(target) = input
                .payload
                .get("targetMessageId")
                .and_then(serde_json::Value::as_str)
            {
                let redacted = tx.query_opt(
                        "SELECT id FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.redacted' AND payload->>'targetMessageId'=$3 LIMIT 1",
                        &[&input.org_id, &input.session_id, &target],
                    ).await.map_err(|e| StoreError::Database(e.to_string()))?;
                if redacted.is_some() {
                    return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
                }
            }
        }
        if let Some(row)=tx.query_opt(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return replay_event(event_from_row(&row), &input); }
        if input.kind == "message.created" {
            if let Some(message_id) = input
                .payload
                .get("messageId")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(row) = tx.query_opt(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.created' AND payload->>'messageId'=$3 LIMIT 1"), &[&input.org_id,&input.session_id,&message_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
                    return Err(conflict(event_from_row(&row)));
                }
            }
        }
        let sequence:i64=tx.query_one("UPDATE chat_sessions SET next_sequence=next_sequence+1,updated_at=$3 WHERE org_id=$1 AND id=$2 AND workspace_id=$4 RETURNING next_sequence-1", &[&input.org_id,&input.session_id,&input.now,&input.workspace_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.get(0);
        let row=tx.query_one(&format!("INSERT INTO chat_session_events (id,org_id,workspace_id,session_id,sequence,kind,actor_kind,actor_id,actor_label,payload,created_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING {EVENT_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&sequence,&input.kind,&input.actor_kind,&input.actor_id,&input.actor_label,&input.payload,&input.now,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(event_from_row(&row))
    }

    async fn append_session_run_event(
        &self,
        input: NewSessionEvent,
        run_id: &str,
        token_hash: &str,
    ) -> Result<SessionEvent, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        let session = self
            .admit_run_write(
                &tx,
                &RunWrite::event(&input, run_id, token_hash),
                &run_requirements(&input),
            )
            .await?;
        if matches!(input.kind.as_str(), "message.created" | "message.corrected") {
            check_tool_detail(&session, input.tool_detail_revision)?;
        }
        if input.kind == "message.corrected" {
            if let Some(target) = input
                .payload
                .get("targetMessageId")
                .and_then(serde_json::Value::as_str)
            {
                let redacted = tx.query_opt(
                        "SELECT id FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.redacted' AND payload->>'targetMessageId'=$3 LIMIT 1",
                        &[&input.org_id, &input.session_id, &target],
                    ).await.map_err(|e| StoreError::Database(e.to_string()))?;
                if redacted.is_some() {
                    return Err(conflict(serde_json::json!({"reason":"message_redacted"})));
                }
            }
        }
        if let Some(row)=tx.query_opt(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return replay_event(event_from_row(&row), &input); }
        if input.kind == "message.created" {
            if let Some(message_id) = input
                .payload
                .get("messageId")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(row) = tx.query_opt(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.created' AND payload->>'messageId'=$3 LIMIT 1"), &[&input.org_id,&input.session_id,&message_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
                    return Err(conflict(event_from_row(&row)));
                }
            }
        }
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
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New).await?;
        tx.query_opt(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&input.org_id, &input.session_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::NotFound)?;
        let member =
            pg_member(&tx, &input.org_id, &input.session_id, &input.holder_user_id).await?;
        if !can_act(member.as_ref(), SessionAction::StartRun) {
            return Err(StoreError::NotFound);
        }
        if let Some(row)=tx.query_opt(&format!("SELECT {LEASE_COLUMNS},token_hash FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            let lease = lease_from_row(&row);
            if row.get::<_, String>("token_hash") != input.token_hash || lease.run_id != input.run_id || lease.holder_user_id != input.holder_user_id || lease.holder_device_id != input.holder_device_id { return Err(StoreError::NotFound); }
            return Ok(lease);
        }
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

    async fn claim_run_queue(
        &self,
        input: NewChatRunLease,
        item_id: &str,
        takeover: bool,
    ) -> Result<(ChatRunLease, ChatRunQueueItem), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        tx.query_opt(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&input.org_id, &input.session_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::NotFound)?;
        let executor =
            pg_member(&tx, &input.org_id, &input.session_id, &input.holder_user_id).await?;
        if !can_act(executor.as_ref(), SessionAction::StartRun) {
            return Err(StoreError::Policy(
                "queue executor cannot start runs".into(),
            ));
        }
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New).await?;
        let item = tx.query_opt(&format!("SELECT {QUEUE_COLUMNS} FROM chat_run_queue WHERE org_id=$1 AND session_id=$2 AND id=$3 FOR UPDATE"), &[&input.org_id,&input.session_id,&item_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        let requested = queue_from_row(&item);
        let requester = pg_member(
            &tx,
            &input.org_id,
            &input.session_id,
            &requested.requested_by_user_id,
        )
        .await?;
        if !can_act(requester.as_ref(), SessionAction::Post) {
            tx.execute("UPDATE chat_run_queue SET status='cancelled' WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='queued'", &[&input.org_id, &input.session_id, &item_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
            tx.commit()
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            return Err(StoreError::Policy("queue requester cannot post".into()));
        }
        if let Some(row) = tx.query_opt(&format!("SELECT {LEASE_COLUMNS},token_hash FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            let lease = lease_from_row(&row);
            if row.get::<_, String>("token_hash") != input.token_hash || lease.run_id != input.run_id || lease.holder_user_id != input.holder_user_id || lease.holder_device_id != input.holder_device_id { return Err(StoreError::NotFound); }
            if lease.queue_item_id.as_deref() != Some(item_id) {
                return Err(conflict(serde_json::json!({"reason":"queue_claim_conflict"})));
            }
            return Ok((lease, queue_from_row(&item)));
        }
        let mut post_permissions = HashMap::from([
            (
                input.holder_user_id.clone(),
                can_act(executor.as_ref(), SessionAction::Post),
            ),
            (requested.requested_by_user_id.clone(), true),
        ]);
        let head = loop {
            let head = tx.query_opt("SELECT id, requested_by_user_id FROM chat_run_queue WHERE org_id=$1 AND session_id=$2 AND status='queued' ORDER BY position LIMIT 1", &[&input.org_id, &input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
            let Some(row) = head.as_ref() else {
                break None;
            };
            let user_id: String = row.get("requested_by_user_id");
            let allowed = if let Some(allowed) = post_permissions.get(&user_id) {
                *allowed
            } else {
                let member = pg_member(&tx, &input.org_id, &input.session_id, &user_id).await?;
                let allowed = can_act(member.as_ref(), SessionAction::Post);
                post_permissions.insert(user_id.clone(), allowed);
                allowed
            };
            if allowed {
                break head;
            }
            // Cancel all pending work from this ineligible requester at once.
            tx.execute("UPDATE chat_run_queue SET status='cancelled' WHERE org_id=$1 AND session_id=$2 AND requested_by_user_id=$3 AND status='queued'", &[&input.org_id, &input.session_id, &user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        };
        if head.is_none_or(|row| row.get::<_, String>("id") != item_id) {
            tx.commit()
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            return Err(StoreError::Conflict(
                serde_json::json!({"reason":"not_queue_head"}),
            ));
        }
        if let Some(row) = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused') AND heartbeat_expires_at>$3"), &[&input.org_id,&input.session_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            let conflict = conflict(lease_from_row(&row));
            tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
            return Err(conflict);
        }
        if let Some(row) = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE"), &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            let last = lease_from_row(&row);
            if matches!(last.status.as_str(), "active" | "paused") && last.heartbeat_expires_at > input.now {
                tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
                return Err(conflict(last));
            }
            if !takeover && (last.status != "released" || last.holder_user_id != input.holder_user_id || last.holder_device_id != input.holder_device_id) {
                tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
                return Err(StoreError::Conflict(serde_json::json!({"reason":"takeover_required"})));
            }
        }
        tx.execute("UPDATE chat_run_leases SET status='expired',updated_at=$3 WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused')", &[&input.org_id,&input.session_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let row = tx.query_one(&format!("INSERT INTO chat_run_leases (id,org_id,workspace_id,session_id,run_id,holder_user_id,holder_device_id,status,token_hash,token_expires_at,heartbeat_expires_at,created_at,updated_at,operation_id,queue_item_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$11,$12,$13) RETURNING {LEASE_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.run_id,&input.holder_user_id,&input.holder_device_id,&input.token_hash,&input.token_expires_at,&input.heartbeat_expires_at,&input.now,&input.operation_id,&item_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let item = tx.query_one(&format!("UPDATE chat_run_queue SET status='claimed' WHERE id=$1 RETURNING {QUEUE_COLUMNS}"), &[&item_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok((lease_from_row(&row), queue_from_row(&item)))
    }

    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        heartbeat_expires_at: i64,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::Write).await?;
        tx.query_opt("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        if !can_act(pg_member(&tx, org_id, session_id, holder_user_id).await?.as_ref(), SessionAction::StartRun) {
            tx.execute("UPDATE chat_run_leases SET status='failed',updated_at=$7 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND holder_user_id=$4 AND holder_device_id=$5 AND token_hash=$6 AND status IN ('active','paused')", &[&org_id,&session_id,&lease_id,&holder_user_id,&holder_device_id,&token_hash,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
            tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
            return Err(StoreError::NotFound);
        }
        let row=tx.query_opt(&format!("UPDATE chat_run_leases SET token_expires_at=$6,heartbeat_expires_at=$6,updated_at=$7 WHERE org_id=$1 AND id=$2 AND holder_user_id=$3 AND holder_device_id=$4 AND token_hash=$5 AND session_id=$8 AND status='active' AND token_expires_at>$7 AND heartbeat_expires_at>$7 RETURNING {LEASE_COLUMNS}"), &[&org_id,&lease_id,&holder_user_id,&holder_device_id,&token_hash,&heartbeat_expires_at,&now,&session_id]).await.map_err(|e|StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(lease_from_row(&row))
    }
    async fn release_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        now: i64,
        status: &str,
    ) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::ContractOnly).await?;
        tx.query_opt("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        if !can_act(pg_member(&tx, org_id, session_id, holder_user_id).await?.as_ref(), SessionAction::StartRun) {
            tx.execute("UPDATE chat_run_leases SET status='failed',updated_at=$7 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND holder_user_id=$4 AND holder_device_id=$5 AND token_hash=$6 AND status IN ('active','paused')", &[&org_id,&session_id,&lease_id,&holder_user_id,&holder_device_id,&token_hash,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
            tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
            return Err(StoreError::NotFound);
        }
        let row=tx.query_opt(&format!("UPDATE chat_run_leases SET status=$4,updated_at=$5 WHERE org_id=$1 AND id=$2 AND holder_user_id=$3 AND session_id=$6 AND holder_device_id=$7 AND token_hash=$8 AND (status IN ('active','paused') OR status=$4) RETURNING {LEASE_COLUMNS}"), &[&org_id,&lease_id,&holder_user_id,&status,&now,&session_id,&holder_device_id,&token_hash]).await.map_err(|e|StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
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
        let holder: String = row.get("holder_user_id");
        if !can_act(pg_member(&tx, org_id, session_id, &holder).await?.as_ref(), SessionAction::StartRun) {
            return Err(StoreError::NotFound);
        }
        Ok(lease_from_row(&row))
    }

    async fn enqueue_run_input(
        &self,
        mut input: NewChatRunQueueItem,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::New).await?;
        let boundary: i64 = tx.query_opt(
            "SELECT next_sequence-1 AS context_sequence FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&input.org_id, &input.session_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::NotFound)?.get("context_sequence");

        if let Some(row) = tx.query_opt(&format!("SELECT {QUEUE_COLUMNS} FROM chat_run_queue WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|error| StoreError::Database(error.to_string()))? {
            return replay_queue(queue_from_row(&row), &input);
        }
        if !can_act(pg_member(&tx, &input.org_id, &input.session_id, &input.requested_by_user_id).await?.as_ref(), SessionAction::Post) {
            return Err(StoreError::NotFound);
        }
        if let Some(payload) = input.payload.as_object_mut() {
            payload.insert("contextSequence".into(), serde_json::json!(boundary));
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
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChatExecution, Requirement::ContractOnly).await?;
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
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::ContractOnly).await?;
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
        tx.query_opt("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        if !can_act(pg_member(&tx, &input.org_id, &input.session_id, &input.requested_by_user_id).await?.as_ref(), SessionAction::StartRun) {
            return Err(StoreError::NotFound);
        }
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChatExecution, Requirement::Write).await?;
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
        tx.query_opt("SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        let current_row = tx.query_opt(&format!("SELECT {APPROVAL_COLUMNS} FROM chat_approval_requests WHERE org_id=$1 AND session_id=$2 AND id=$3 FOR UPDATE"), &[&org_id,&session_id,&approval_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        let current = approval_from_row(&current_row);
        let action = if current.risk == "high" { SessionAction::ApproveHighRisk } else { SessionAction::ApproveOrdinary };
        if !can_act(pg_member(&tx, org_id, session_id, resolver_user_id).await?.as_ref(), action) {
            return Err(StoreError::NotFound);
        }
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChatExecution, if status == "denied" { Requirement::ContractOnly } else if current.risk == "high" { Requirement::New } else { Requirement::Write }).await?;
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
        self.admit_chat(&tx, &input.org_id, &input.session_id, FeatureKey::SharedChat, Requirement::Write).await?;
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
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::Write).await?;
        let row = tx.query_opt(&format!("UPDATE chat_attachments SET status='available',event_id=$4,updated_at=$5 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='pending' RETURNING {ATTACHMENT_COLUMNS}"), &[&org_id,&session_id,&attachment_id,&event_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        if let Some(row) = row {
            tx.commit()
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
            return Ok(attachment_from_row(&row));
        }
        let current = tx.query_opt(&format!("SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments WHERE org_id=$1 AND session_id=$2 AND id=$3"), &[&org_id,&session_id,&attachment_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        let current = attachment_from_row(&current);
        if current.status == "available" && current.event_id.as_deref() == event_id {
            return Ok(current);
        }
        Err(conflict(current))
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
        self.admit_chat(&tx, org_id, session_id, FeatureKey::SharedChat, Requirement::ContractOnly).await?;
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

    fn fixture_store() -> InMemoryChatStore {
        let store = crate::store::InMemoryStore::new();
        for user in &["member","usr_invited","usr_next","usr_other","usr_outsider","usr_owner","viewer"] {
            store.add_org_member("org_1", user, cognia_tenant_auth::OrgRole::Member);
            store.add_workspace_member("org_1", "ws_1", user, cognia_tenant_auth::WorkspaceRole::Maintainer);
        }
        InMemoryChatStore::from_store(&store)
    }


    fn live_write(token: &str, now: i64) -> RunWrite<'_> {
        RunWrite {
            org_id: "org_1",
            session_id: "ses_1",
            run_id: "run",
            token_hash: token,
            now,
        }
    }

    #[tokio::test]
    async fn live_admission_rechecks_rollout_and_terminal_events_can_drain() {
        use crate::rollout::Phase;
        for feature in [FeatureKey::SharedChat, FeatureKey::SharedChatExecution] {
            for (phase, kill) in [
                (Phase::Paused, false),
                (Phase::Off, false),
                (Phase::General, true),
            ] {
                let store = fixture_store();
                store.create_session(session("create")).await.unwrap();
                store
                    .acquire_run_lease(replay_lease("usr_owner"))
                    .await
                    .unwrap();
                store.append_session_event(replay_event()).await.unwrap();
                assert!(store
                    .admit_live_frame(live_write("hash", 5), "message", 0)
                    .await
                    .is_ok());
                let mut policy = crate::rollout::tests::policy();
                policy.feature_key = feature;
                policy.phase = phase;
                policy.kill = kill;
                store
                    .tables
                    .write()
                    .feature_policies
                    .insert(feature, policy);
                let result = store
                    .admit_live_frame(live_write("hash", 5), "message", 0)
                    .await;
                if kill {
                    assert!(matches!(result, Err(StoreError::FeatureUnavailable(_))));
                } else {
                    assert!(
                        result.is_ok(),
                        "paused/off policy preserves existing writes: {result:?}"
                    );
                }
                let mut terminal = replay_event();
                terminal.kind = "run.completed".into();
                terminal.actor_id = "run:run".into();
                terminal.actor_kind = "agent".into();
                terminal.id = "terminal".into();
                terminal.operation_id = "terminal".into();
                store
                    .append_session_run_event(terminal, "run", "hash")
                    .await
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn live_admission_rejects_invalid_expired_and_revoked_holders() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        assert!(store
            .admit_live_frame(live_write("hash", 5), "message", 0)
            .await
            .is_err());
        store
            .acquire_run_lease(replay_lease("usr_owner"))
            .await
            .unwrap();
        assert!(store
            .admit_live_frame(live_write("wrong", 5), "message", 0)
            .await
            .is_err());
        assert!(store
            .admit_live_frame(live_write("hash", 100), "message", 0)
            .await
            .is_err());
        store
            .tables
            .write()
            .chat
            .memberships
            .get_mut(&("ses_1".into(), "usr_owner".into()))
            .unwrap()
            .role = SessionRole::Viewer;
        assert!(store
            .admit_live_frame(live_write("hash", 5), "message", 0)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn tool_detail_store_checks_are_atomic_and_old_executors_remain_compatible() {
        let store = fixture_store();
        let initial = store.create_session(session("create")).await.unwrap();
        assert_eq!(
            (initial.tool_detail, initial.tool_detail_revision),
            (ToolDetail::Summary, 0)
        );
        store
            .put_member(
                "org_1",
                "ses_1",
                "ws_1",
                "member",
                SessionRole::Member,
                false,
                false,
                "usr_owner",
                2,
            )
            .await
            .unwrap();
        assert!(matches!(
            store
                .patch_session(
                    "org_1",
                    "ses_1",
                    None,
                    None,
                    Some((ToolDetail::Full, "member")),
                    "denied",
                    1,
                    3
                )
                .await,
            Err(StoreError::Policy(_))
        ));
        let full = store
            .patch_session(
                "org_1",
                "ses_1",
                None,
                None,
                Some((ToolDetail::Full, "usr_owner")),
                "full",
                1,
                3,
            )
            .await
            .unwrap();
        assert_eq!(full.tool_detail_revision, 1);
        assert_eq!(full.policy_revision, initial.policy_revision + 2);
        let same = store
            .patch_session(
                "org_1",
                "ses_1",
                None,
                None,
                Some((ToolDetail::Full, "usr_owner")),
                "same",
                full.revision,
                3,
            )
            .await
            .unwrap();
        assert_eq!(same, full);
        store
            .acquire_run_lease(replay_lease("usr_owner"))
            .await
            .unwrap();
        let mut event = replay_event();
        event.actor_kind = "agent".into();
        event.actor_id = "run:run".into();
        event.tool_detail_revision = Some(0);
        assert!(
            matches!(store.append_session_run_event(event.clone(),"run","hash").await,Err(StoreError::Conflict(v)) if v["reason"]=="tool_detail_stale" && v["toolDetail"]=="full" && v["toolDetailRevision"]==1)
        );
        event.tool_detail_revision = None;
        store
            .append_session_run_event(event.clone(), "run", "hash")
            .await
            .unwrap();
        assert!(
            matches!(store.admit_live_frame(live_write("hash",5),"message",0).await,Err(StoreError::Conflict(v)) if v["reason"]=="tool_detail_stale")
        );
        assert!(store
            .admit_live_frame(live_write("hash", 5), "message", 1)
            .await
            .is_ok());
        let before = store
            .list_session_events("org_1", "ses_1", 0, 100)
            .await
            .unwrap();
        assert_eq!(before.len(), 1);
        event.kind = "message.corrected".into();
        event.id = "correction".into();
        event.operation_id = "correction".into();
        event.payload = serde_json::json!({"targetMessageId":"message","parts":[]});
        event.tool_detail_revision = Some(0);
        assert!(
            matches!(store.append_session_run_event(event.clone(),"run","hash").await,Err(StoreError::Conflict(v)) if v["reason"]=="tool_detail_stale")
        );
        event.tool_detail_revision = Some(1);
        store
            .append_session_run_event(event, "run", "hash")
            .await
            .unwrap();
        assert_eq!(
            store
                .list_session_events("org_1", "ses_1", 0, 100)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn redacted_corrections_are_rejected_inside_both_memory_append_paths() {
        for run in [false, true] {
            let store = fixture_store();
            store.create_session(session("create")).await.unwrap();
            store
                .acquire_run_lease(replay_lease("usr_owner"))
                .await
                .unwrap();
            let original = replay_event();
            store.append_session_event(original.clone()).await.unwrap();
            let mut correction = original.clone();
            correction.id = "correct".into();
            correction.operation_id = "correct".into();
            correction.kind = "message.corrected".into();
            correction.payload = serde_json::json!({"targetMessageId":"message","parts":[{"type":"text","text":"corrected"}]});
            if run {
                correction.actor_kind = "agent".into();
                correction.actor_id = "run:run".into();
            }
            let append = |input| async {
                if run {
                    store.append_session_run_event(input, "run", "hash").await
                } else {
                    store.append_session_event(input).await
                }
            };
            append(correction.clone()).await.unwrap();
            let mut redaction = original;
            redaction.id = "redact".into();
            redaction.operation_id = "redact".into();
            redaction.kind = "message.redacted".into();
            redaction.payload = serde_json::json!({"targetMessageId":"message"});
            store.append_session_event(redaction).await.unwrap();
            for replay in [false, true] {
                let mut input = correction.clone();
                if !replay {
                    input.id = "late".into();
                    input.operation_id = "late".into();
                }
                let result = append(input).await;
                assert!(
                    matches!(result, Err(StoreError::Conflict(ref value)) if value["reason"] == "message_redacted"),
                    "run={run} replay={replay}: {result:?}"
                );
            }
            assert_eq!(
                store
                    .list_session_events("org_1", "ses_1", 0, 100)
                    .await
                    .unwrap()
                    .len(),
                3
            );
        }
    }

    #[test]
    fn session_discovery_qualifies_whole_columns_without_corrupting_identifiers() {
        assert_eq!(qualified_session_columns(), "s.id, s.org_id, s.workspace_id, s.title, s.status, s.created_by_user_id, s.created_at, s.updated_at, s.revision, s.policy_revision, s.contract_version, s.tool_detail, s.tool_detail_revision");
    }

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

    fn replay_event() -> NewSessionEvent {
        NewSessionEvent {
            tool_detail_revision: None,
            id: "event".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            kind: "message.created".into(),
            actor_kind: "human".into(),
            actor_id: "usr_owner".into(),
            actor_label: None,
            payload: serde_json::json!({"messageId":"message","parts":[]}),
            now: 2,
            operation_id: "event-op".into(),
        }
    }

    fn replay_queue(user: &str, id: &str) -> NewChatRunQueueItem {
        NewChatRunQueueItem {
            id: id.into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            requested_by_user_id: user.into(),
            payload: serde_json::json!({"messageId":"message","parts":[]}),
            now: 3,
            operation_id: id.into(),
        }
    }

    fn replay_lease(user: &str) -> NewChatRunLease {
        NewChatRunLease {
            id: "lease".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            run_id: "run".into(),
            holder_user_id: user.into(),
            holder_device_id: "device".into(),
            token_hash: "hash".into(),
            token_expires_at: 100,
            heartbeat_expires_at: 100,
            now: 4,
            operation_id: "lease-op".into(),
        }
    }

    fn standing_fixture() -> (crate::store::InMemoryStore, InMemoryChatStore) {
        use cognia_tenant_auth::{OrgRole, WorkspaceRole};
        let store = crate::store::InMemoryStore::new();
        store.add_workspace("org_1", "ws_1", "Workspace");
        for user in ["usr_owner", "member", "guest"] {
            store.add_user(user, user);
            store.add_org_member("org_1", user, OrgRole::Member);
            store.add_workspace_member("org_1", "ws_1", user, WorkspaceRole::Maintainer);
        }
        store.add_org_member("org_1", "usr_owner", OrgRole::Owner);
        let chat = InMemoryChatStore::from_store(&store);
        (store, chat)
    }

    fn standing_context() -> crate::store::AuthorizationContext {
        crate::store::AuthorizationContext {
            actor_user_id: "usr_owner".into(), reason: "standing regression".into(), request_id: "request".into(),
            grant_id: None, source: serde_json::json!({}), now: 5,
        }
    }

    #[tokio::test]
    async fn offboard_and_workspace_removal_revoke_members_work_and_issued_invites_but_not_guests() {
        use crate::store::Store;
        for offboard in [true, false] {
            let (store, chat) = standing_fixture();
            chat.create_session(session("create")).await.unwrap();
            chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 2).await.unwrap();
            chat.put_member("org_1", "ses_1", "ws_1", "guest", SessionRole::Member, false, true, "usr_owner", 2).await.unwrap();
            chat.enqueue_run_input(replay_queue("member", "queue")).await.unwrap();
            chat.acquire_run_lease(replay_lease("member")).await.unwrap();
            chat.create_invite(NewChatSessionInvite {
                id: "invite".into(), org_id: "org_1".into(), workspace_id: "ws_1".into(), session_id: "ses_1".into(),
                token_hash: "invite-hash".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
                created_by_user_id: "member".into(), expires_at: 100, now: 3,
            }).await.unwrap();
            let revision = chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision;
            let affected = if offboard {
                store.offboard_org_member("org_1", "member", standing_context()).await.unwrap()
            } else {
                store.remove_workspace_member("org_1", "ws_1", "member", standing_context()).await.unwrap()
            };
            assert_eq!(affected, ["ses_1"]);
            assert_eq!(chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision, revision + 1);
            assert!(chat.visible_session("org_1", "ses_1", "member").await.unwrap().is_none());
            assert!(chat.claim_run_queue(replay_lease("member"), "queue", false).await.is_err());
            assert_eq!(chat.tables.read().chat.queue["queue"].0.status, "cancelled");
            assert_eq!(chat.tables.read().chat.leases["lease"].0.status, "failed");
            assert_eq!(chat.list_invites("org_1", "ses_1", 6).await.unwrap()[0].status, "revoked");
            assert!(matches!(chat.accept_invite("org_1", "invite-hash", "new-guest", 6).await, Err(StoreError::InvitationUnavailable)));
            assert!(chat.visible_session("org_1", "ses_1", "guest").await.unwrap().is_some());
            store.remove_workspace_member("org_1", "ws_1", "guest", standing_context()).await.unwrap();
            chat.enqueue_run_input(replay_queue("guest", "guest-queue")).await.unwrap();
            let mut guest_lease = replay_lease("guest");
            guest_lease.id = "guest-lease".into();
            guest_lease.run_id = "guest-run".into();
            guest_lease.operation_id = "guest-lease-op".into();
            chat.acquire_run_lease(guest_lease).await.unwrap();
            store.offboard_org_member("org_1", "guest", standing_context()).await.unwrap();
            assert_eq!(chat.tables.read().chat.leases["guest-lease"].0.status, "failed");
            assert_eq!(chat.tables.read().chat.queue["guest-queue"].0.status, "cancelled");
            assert!(chat.visible_session("org_1", "ses_1", "guest").await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn a_revoked_manager_cannot_mutate_members_or_issue_invites_after_authorization() {
        use crate::store::Store;
        let (store, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 2).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "guest", SessionRole::Member, false, true, "usr_owner", 2).await.unwrap();
        let authorized = chat.effective_member("org_1", "ses_1", "member").await.unwrap().unwrap();
        assert!(can_act(Some(&authorized), SessionAction::ManageMembers));
        store.offboard_org_member("org_1", "member", standing_context()).await.unwrap();
        // The API's earlier authorization must not be reusable after commit.
        assert!(matches!(chat.put_member("org_1", "ses_1", "ws_1", "guest", SessionRole::Member, false, true, "member", 6).await, Err(StoreError::Policy(_))));
        assert!(matches!(chat.put_member("org_1", "ses_1", "ws_1", "guest", SessionRole::Viewer, false, true, "member", 6).await, Err(StoreError::Policy(_))));
        assert!(matches!(chat.put_member("org_1", "ses_1", "ws_1", "usr_owner", SessionRole::Owner, false, false, "member", 6).await, Err(StoreError::Policy(_))));
        assert!(matches!(chat.remove_member("org_1", "ses_1", "guest", "member", 6).await, Err(StoreError::Policy(_))));
        assert!(matches!(chat.create_invite(NewChatSessionInvite {
            id: "racing-invite".into(), org_id: "org_1".into(), workspace_id: "ws_1".into(), session_id: "ses_1".into(),
            token_hash: "racing-hash".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
            created_by_user_id: "member".into(), expires_at: 100, now: 6,
        }).await, Err(StoreError::Policy(_))));
    }

    #[tokio::test]
    async fn external_session_guest_cannot_be_offboarded_from_an_org_they_never_joined() {
        use crate::store::Store;
        let (store, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        store.add_user("external", "External guest");
        chat.put_member("org_1", "ses_1", "ws_1", "external", SessionRole::Member, false, true, "usr_owner", 2).await.unwrap();
        assert!(matches!(store.offboard_org_member("org_1", "external", standing_context()).await, Err(StoreError::NotFound)));
        assert!(chat.effective_member("org_1", "ses_1", "external").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn actor_role_changes_are_rechecked_against_the_current_target_under_the_lock() {
        let (_, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Owner, true, false, "usr_owner", 2).await.unwrap();
        let actor_before = chat.effective_member("org_1", "ses_1", "member").await.unwrap().unwrap();
        assert!(crate::chat::can_change_member_role(actor_before.role, Some(SessionRole::Owner), SessionRole::Owner));
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 3).await.unwrap();
        assert!(matches!(chat.put_member("org_1", "ses_1", "ws_1", "usr_owner", SessionRole::Owner, false, false, "member", 4).await, Err(StoreError::Policy(_))));
        assert!(matches!(chat.remove_member("org_1", "ses_1", "usr_owner", "member", 4).await, Err(StoreError::Policy(_))));
        // A member still may leave their own session.
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Member, false, false, "usr_owner", 5).await.unwrap();
        chat.remove_member("org_1", "ses_1", "member", "member", 6).await.unwrap();
    }

    #[tokio::test]
    async fn offboarding_blocks_incoming_old_invites_but_not_external_guests_or_new_invites() {
        use crate::store::Store;
        let (store, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        let invite = |id: &str, target: Option<&str>, now| NewChatSessionInvite {
            id: id.into(), org_id: "org_1".into(), workspace_id: "ws_1".into(), session_id: "ses_1".into(),
            token_hash: id.into(), target_user_id: target.map(str::to_owned), role: SessionRole::Member, approver: false, guest: true,
            created_by_user_id: "usr_owner".into(), expires_at: 100, now,
        };
        chat.create_invite(invite("targeted", Some("member"), 3)).await.unwrap();
        chat.create_invite(invite("token", None, 3)).await.unwrap();
        chat.create_invite(invite("same-time", None, 5)).await.unwrap();
        store.offboard_org_member("org_1", "member", standing_context()).await.unwrap();
        assert_eq!(chat.list_invites("org_1", "ses_1", 6).await.unwrap().into_iter().find(|i| i.id == "targeted").unwrap().status, "revoked");
        assert!(matches!(chat.accept_targeted_invite("org_1", "targeted", "member", 6).await, Err(StoreError::InvitationUnavailable)));
        for token in ["targeted", "token", "same-time"] {
            assert!(matches!(chat.accept_invite("org_1", token, "member", 6).await, Err(StoreError::InvitationUnavailable)), "{token}");
        }
        assert!(chat.effective_member("org_1", "ses_1", "member").await.unwrap().is_none());
        let (_, external) = chat.accept_invite("org_1", "token", "external", 6).await.unwrap();
        assert!(external.guest);
        chat.create_invite(invite("new-token", None, 6)).await.unwrap();
        let (_, readmitted) = chat.accept_invite("org_1", "new-token", "member", 7).await.unwrap();
        assert!(readmitted.guest);
    }

    #[tokio::test]
    async fn losing_a_workspace_seat_keeps_an_org_admins_session_standing() {
        use crate::store::Store;
        use cognia_tenant_auth::OrgRole;
        let (store, chat) = standing_fixture();
        store.add_org_member("org_1", "member", OrgRole::Admin);
        chat.create_session(session("create")).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 2).await.unwrap();
        let revision = chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision;
        let affected = store.remove_workspace_member("org_1", "ws_1", "member", standing_context()).await.unwrap();
        assert!(affected.is_empty(), "an org admin still traverses the workspace");
        assert_eq!(chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision, revision);
        let member = chat.effective_member("org_1", "ses_1", "member").await.unwrap().unwrap();
        assert_eq!(member.role, SessionRole::Maintainer);
        assert!(member.approver);
    }

    #[tokio::test]
    async fn workspace_demotions_cap_roles_and_clear_viewer_approver_atomically() {
        use crate::store::Store;
        use cognia_tenant_auth::WorkspaceRole;
        let (store, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 2).await.unwrap();
        let before = chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision;
        assert!(store.set_workspace_member("org_1", "ws_1", "member", WorkspaceRole::Member, standing_context()).await.unwrap().is_empty());
        let member = chat.effective_member("org_1", "ses_1", "member").await.unwrap().unwrap();
        assert_eq!(member.role, SessionRole::Maintainer);
        assert!(member.approver, "writer standing preserves existing session management");
        store.set_workspace_member("org_1", "ws_1", "member", WorkspaceRole::Viewer, standing_context()).await.unwrap();
        let member = chat.effective_member("org_1", "ses_1", "member").await.unwrap().unwrap();
        assert_eq!(member.role, SessionRole::Viewer);
        assert!(!member.approver);
        assert_eq!(chat.tables.read().chat.memberships[&("ses_1".into(), "member".into())].role, SessionRole::Viewer);
        assert_eq!(chat.admin_session("org_1", "ses_1").await.unwrap().policy_revision, before + 1);
    }

    #[tokio::test]
    async fn workspace_cleanup_is_scoped_and_org_cleanup_returns_sessions_in_order() {
        use crate::store::Store;
        let (store, chat) = standing_fixture();
        store.add_workspace_member("org_1", "ws_2", "member", cognia_tenant_auth::WorkspaceRole::Member);
        for (id, workspace, guest) in [("ses_z", "ws_1", false), ("ses_a", "ws_2", false), ("ses_guest", "ws_1", true)] {
            let mut input = session(id);
            input.id = id.into();
            input.workspace_id = workspace.into();
            chat.create_session(input).await.unwrap();
            chat.put_member("org_1", id, workspace, "member", SessionRole::Member, false, guest, "usr_owner", 2).await.unwrap();
        }
        // The membership is already at or below the new ceiling: nothing the
        // person may do changed, so no revision bump and no ticket revocation.
        let before = chat.admin_session("org_1", "ses_z").await.unwrap().policy_revision;
        assert!(store.set_workspace_member("org_1", "ws_1", "member", cognia_tenant_auth::WorkspaceRole::Member, standing_context()).await.unwrap().is_empty());
        assert_eq!(chat.admin_session("org_1", "ses_z").await.unwrap().policy_revision, before);
        assert_eq!(store.offboard_org_member("org_1", "member", standing_context()).await.unwrap(), ["ses_a", "ses_guest", "ses_z"]);
        assert!(chat.effective_member("org_1", "ses_guest", "member").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn legacy_standing_is_fenced_before_cleanup_and_audit_repairs_it() {
        let (store, chat) = standing_fixture();
        chat.create_session(session("create")).await.unwrap();
        chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Maintainer, true, false, "usr_owner", 2).await.unwrap();
        chat.acquire_run_lease(replay_lease("member")).await.unwrap();
        let approval = chat.create_approval(NewChatApprovalRequest {
            id: "approval".into(), org_id: "org_1".into(), workspace_id: "ws_1".into(), session_id: "ses_1".into(),
            run_id: "run".into(), action: "delete".into(), risk: "high".into(), requested_by_user_id: "member".into(),
            expires_at: 90, now: 4, operation_id: "approval-op".into(),
        }).await.unwrap();
        chat.create_invite(NewChatSessionInvite {
            id: "invite".into(), org_id: "org_1".into(), workspace_id: "ws_1".into(), session_id: "ses_1".into(),
            token_hash: "invite-hash".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
            created_by_user_id: "member".into(), expires_at: 100, now: 3,
        }).await.unwrap();
        // Simulate an old offboarding that left all session rows intact.
        store.tables.write().org_memberships.remove(&("org_1".into(), "member".into()));
        store.tables.write().workspace_memberships.remove(&("org_1".into(), "ws_1".into(), "member".into()));
        assert!(chat.visible_session("org_1", "ses_1", "member").await.unwrap().is_none());
        assert!(chat.list_sessions("org_1", "member", None).await.unwrap().is_empty());
        assert!(!chat.list_members("org_1", "ses_1").await.unwrap().iter().any(|m| m.user_id == "member"));
        assert!(chat.resolve_approval("org_1", "ses_1", "approval", "member", "approved", approval.revision, 5).await.is_err());
        assert!(matches!(chat.accept_invite("org_1", "invite-hash", "new-guest", 5).await, Err(StoreError::InvitationUnavailable)));
        let dry = chat.audit_standing(false, 1, 5).unwrap();
        assert_eq!(dry.missing_standing, 1);
        assert_eq!(dry.issues[0].user_id, "member");
        assert!(chat.tables.read().chat.memberships.contains_key(&("ses_1".into(), "member".into())));
        let applied = chat.audit_standing(true, 1, 5).unwrap();
        assert_eq!(applied.applied, 1);
        assert_eq!(chat.tables.read().chat.leases["lease"].0.status, "failed");
        assert!(chat.audit_standing(false, 1, 5).unwrap().issues.is_empty());
    }

    #[tokio::test]
    async fn legacy_demotion_fences_heartbeat_completion_and_caps_listing_without_writes() {
        use cognia_tenant_auth::WorkspaceRole;
        for heartbeat in [true, false] {
            let (store, chat) = standing_fixture();
            chat.create_session(session("create")).await.unwrap();
            chat.put_member("org_1", "ses_1", "ws_1", "member", SessionRole::Member, true, false, "usr_owner", 2).await.unwrap();
            chat.acquire_run_lease(replay_lease("member")).await.unwrap();
            store.add_workspace_member("org_1", "ws_1", "member", WorkspaceRole::Viewer);
            let member = chat.list_members("org_1", "ses_1").await.unwrap().into_iter().find(|m| m.user_id == "member").unwrap();
            assert_eq!(member.role, SessionRole::Viewer);
            assert!(!member.approver);
            let result = if heartbeat {
                chat.heartbeat_run_lease("org_1", "ses_1", "lease", "member", "device", "hash", 90, 5).await
            } else {
                chat.release_run_lease("org_1", "ses_1", "lease", "member", "device", "hash", 5, "completed").await
            };
            assert!(result.is_err());
            assert_eq!(chat.tables.read().chat.leases["lease"].0.status, "failed");
            assert_eq!(chat.audit_standing(true, 1, 6).unwrap().applied, 1);
        }
    }

    #[tokio::test]
    async fn semantic_event_replays_reject_changed_payload_kind_or_actor() {
        for run_event in [false, true] {
            let store = fixture_store();
            store.create_session(session("create")).await.unwrap();
            store
                .acquire_run_lease(replay_lease("usr_owner"))
                .await
                .unwrap();
            let input = replay_event();
            let append = |input| async {
                if run_event {
                    store.append_session_run_event(input, "run", "hash").await
                } else {
                    store.append_session_event(input).await
                }
            };
            let first = append(input.clone()).await.unwrap();
            let mut retry = input.clone();
            retry.id = "regenerated-id".into();
            retry.now = 5;
            assert_eq!(append(retry).await.unwrap(), first);
            for field in ["payload", "kind", "actor", "actor-kind"] {
                let mut changed = input.clone();
                match field {
                    "payload" => changed.payload["parts"] = serde_json::json!(["changed"]),
                    "kind" => changed.kind = "message.corrected".into(),
                    "actor" => changed.actor_id = "other".into(),
                    _ => changed.actor_kind = "guest".into(),
                }
                assert!(
                    matches!(append(changed).await, Err(StoreError::Conflict(_))),
                    "{field}"
                );
            }
            assert_eq!(
                store
                    .list_session_events("org_1", "ses_1", 0, 100)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn semantic_queue_replays_preserve_boundary_and_reject_changed_request() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        let input = replay_queue("usr_owner", "queue");
        let first = store.enqueue_run_input(input.clone()).await.unwrap();
        store.append_session_event(replay_event()).await.unwrap();
        let mut retry = input.clone();
        retry.id = "regenerated-id".into();
        retry.now = 5;
        retry.payload["contextSequence"] = serde_json::json!(500);
        let replay = store.enqueue_run_input(retry).await.unwrap();
        assert_eq!(replay.id, first.id);
        assert_eq!(replay.payload, first.payload);
        for field in ["message", "actor", "parts"] {
            let mut changed = input.clone();
            match field {
                "message" => changed.payload["messageId"] = serde_json::json!("different"),
                "actor" => changed.requested_by_user_id = "other".into(),
                _ => changed.payload["parts"] = serde_json::json!(["changed"]),
            }
            assert!(
                matches!(
                    store.enqueue_run_input(changed).await,
                    Err(StoreError::Conflict(_))
                ),
                "{field}"
            );
        }
    }

    #[tokio::test]
    async fn permission_loss_cancels_queued_requests_and_fails_only_live_leases() {
        for remove in [false, true] {
            let store = fixture_store();
            store.create_session(session("create")).await.unwrap();
            store
                .put_member(
                    "org_1",
                    "ses_1",
                    "ws_1",
                    "member",
                    SessionRole::Member,
                    false,
                    false,
                    "usr_owner",
                    2,
                )
                .await
                .unwrap();
            store
                .enqueue_run_input(replay_queue("member", "revoked"))
                .await
                .unwrap();
            store
                .enqueue_run_input(replay_queue("usr_owner", "next"))
                .await
                .unwrap();
            store
                .acquire_run_lease(replay_lease("member"))
                .await
                .unwrap();
            if remove {
                store
                    .remove_member("org_1", "ses_1", "member", "usr_owner", 5)
                    .await
                    .unwrap();
            } else {
                store
                    .put_member(
                        "org_1",
                        "ses_1",
                        "ws_1",
                        "member",
                        SessionRole::Viewer,
                        false,
                        false,
                        "usr_owner",
                        5,
                    )
                    .await
                    .unwrap();
            }
            assert!(store
                .validate_run_token("org_1", "ses_1", "run", "hash", 6)
                .await
                .is_err());
            assert_eq!(
                store
                    .list_run_queue("org_1", "ses_1")
                    .await
                    .unwrap()
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["next"]
            );
            let mut lease = replay_lease("usr_owner");
            lease.id = "next-lease".into();
            lease.run_id = "next-run".into();
            lease.operation_id = "next-claim".into();
            lease.now = 6;
            assert!(store.claim_run_queue(lease, "next", true).await.is_ok());
        }
    }

    #[tokio::test]
    async fn claim_cancels_legacy_ineligible_heads_without_blocking_the_next_request() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        store
            .enqueue_run_input(replay_queue("usr_owner", "stale"))
            .await
            .unwrap();
        store
            .enqueue_run_input(replay_queue("usr_owner", "next"))
            .await
            .unwrap();
        // Simulate a queued row written before revocation cleanup existed.
        store
            .tables
            .write()
            .chat.queue
            .get_mut("stale")
            .unwrap()
            .0
            .requested_by_user_id = "removed".into();
        assert!(store
            .claim_run_queue(replay_lease("usr_owner"), "next", false)
            .await
            .is_ok());
        assert_eq!(store.tables.read().chat.queue["stale"].0.status, "cancelled");
    }

    #[tokio::test]
    async fn queue_claim_replay_is_bound_to_the_original_queue_item() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        store
            .enqueue_run_input(replay_queue("usr_owner", "first"))
            .await
            .unwrap();
        store
            .enqueue_run_input(replay_queue("usr_owner", "second"))
            .await
            .unwrap();
        let lease = replay_lease("usr_owner");
        let original = store
            .claim_run_queue(lease.clone(), "first", false)
            .await
            .unwrap();
        assert_eq!(
            store
                .claim_run_queue(lease.clone(), "first", false)
                .await
                .unwrap()
                .0,
            original.0
        );
        assert!(matches!(
            store.claim_run_queue(lease.clone(), "second", false).await,
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(
            store.list_run_queue("org_1", "ses_1").await.unwrap()[0].id,
            "second"
        );
    }

    #[tokio::test]
    async fn queue_claim_rejects_a_legacy_lease_with_no_durable_queue_binding() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        store
            .enqueue_run_input(replay_queue("usr_owner", "queue"))
            .await
            .unwrap();
        let lease = replay_lease("usr_owner");
        store.acquire_run_lease(lease.clone()).await.unwrap();
        assert!(matches!(
            store.claim_run_queue(lease, "queue", false).await,
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(
            store.list_run_queue("org_1", "ses_1").await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn membership_updates_preserve_owner_scope_and_terminal_lease_history() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        assert!(store
            .put_member(
                "org_1",
                "ses_1",
                "ws_1",
                "usr_owner",
                SessionRole::Viewer,
                false,
                false,
                "usr_owner",
                2
            )
            .await
            .is_err());
        assert!(store
            .remove_member("other-org", "ses_1", "usr_owner", "usr_owner", 2)
            .await
            .is_err());
        let (session, owner) = store
            .visible_session("org_1", "ses_1", "usr_owner")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.role, SessionRole::Owner);
        assert_eq!(session.policy_revision, 1);
        store
            .put_member(
                "org_1",
                "ses_1",
                "ws_1",
                "member",
                SessionRole::Member,
                false,
                false,
                "usr_owner",
                2,
            )
            .await
            .unwrap();
        store
            .acquire_run_lease(replay_lease("member"))
            .await
            .unwrap();
        store
            .release_run_lease(
                "org_1", "ses_1", "lease", "member", "device", "hash", 5, "released",
            )
            .await
            .unwrap();
        store
            .remove_member("org_1", "ses_1", "member", "usr_owner", 6)
            .await
            .unwrap();
        assert!(store.release_run_lease("org_1", "ses_1", "lease", "member", "device", "hash", 7, "completed").await.is_err());
        assert_eq!(store.tables.read().chat.leases["lease"].0.status, "released");
        assert!(store
            .acquire_run_lease(replay_lease("member"))
            .await
            .is_err());
        assert!(store
            .enqueue_run_input(replay_queue("member", "late"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn accepting_an_invite_never_changes_an_existing_members_capabilities() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        store
            .put_member(
                "org_1",
                "ses_1",
                "ws_1",
                "viewer",
                SessionRole::Viewer,
                false,
                true,
                "usr_owner",
                2,
            )
            .await
            .unwrap();
        for (user, role) in [
            ("usr_owner", SessionRole::Viewer),
            ("viewer", SessionRole::Maintainer),
        ] {
            let before = store
                .visible_session("org_1", "ses_1", user)
                .await
                .unwrap()
                .unwrap()
                .1;
            store
                .create_invite(NewChatSessionInvite {
                    id: format!("invite-{user}"),
                    org_id: "org_1".into(),
                    workspace_id: "ws_1".into(),
                    session_id: "ses_1".into(),
                    token_hash: user.into(),
                    target_user_id: Some(user.into()),
                    role,
                    approver: false,
                    guest: false,
                    created_by_user_id: "usr_owner".into(),
                    expires_at: 100,
                    now: 3,
                })
                .await
                .unwrap();
            let (invite, member) = store.accept_invite("org_1", user, user, 4).await.unwrap();
            assert_eq!(invite.status, "accepted");
            assert_eq!(member, before);
        }
    }

    #[tokio::test]
    async fn creation_is_idempotent_and_only_the_owner_can_discover_the_session() {
        let store = fixture_store();
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
    async fn lease_retries_and_mutations_are_bound_to_the_session_run_user_device_and_token() {
        let store = fixture_store();
        store.create_session(session("create")).await.unwrap();
        let input = NewChatRunLease {
            id: "lease".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            run_id: "run".into(),
            holder_user_id: "usr_owner".into(),
            holder_device_id: "device".into(),
            token_hash: "digest".into(),
            token_expires_at: 100,
            heartbeat_expires_at: 50,
            now: 2,
            operation_id: "acquire".into(),
        };
        let lease = store.acquire_run_lease(input.clone()).await.unwrap();
        assert_eq!(store.acquire_run_lease(input.clone()).await.unwrap(), lease);
        let original = NewSessionEvent {
            tool_detail_revision: None,
            id: "original".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            kind: "message.created".into(),
            actor_kind: "human".into(),
            actor_id: "usr_owner".into(),
            actor_label: None,
            payload: serde_json::json!({"messageId":"message", "role":"user", "parts":[{"type":"text", "text":"original"}]}),
            now: 3,
            operation_id: "original-op".into(),
        };
        let durable = store.append_session_event(original.clone()).await.unwrap();
        assert_eq!(
            store.append_session_event(original.clone()).await.unwrap(),
            durable
        );
        let mut replacement = original;
        replacement.id = "replacement".into();
        replacement.operation_id = "replacement-op".into();
        replacement.actor_id = "another-member".into();
        replacement.payload["parts"] = serde_json::json!([]);
        assert!(matches!(
            store.append_session_event(replacement.clone()).await,
            Err(StoreError::Conflict(_))
        ));
        replacement.actor_kind = "agent".into();
        replacement.actor_id = "run:run".into();
        assert!(matches!(
            store
                .append_session_run_event(replacement, "run", "digest")
                .await,
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(
            store
                .list_session_events("org_1", "ses_1", 0, 100)
                .await
                .unwrap(),
            vec![durable]
        );
        for field in ["token", "device", "user", "run"] {
            let mut replay = input.clone();
            match field {
                "token" => replay.token_hash = "other".into(),
                "device" => replay.holder_device_id = "other".into(),
                "user" => replay.holder_user_id = "other".into(),
                _ => replay.run_id = "other".into(),
            }
            assert!(matches!(
                store.acquire_run_lease(replay).await,
                Err(StoreError::NotFound)
            ));
        }
        for (session, user, device, token) in [
            ("other", "usr_owner", "device", "digest"),
            ("ses_1", "other", "device", "digest"),
            ("ses_1", "usr_owner", "other", "digest"),
            ("ses_1", "usr_owner", "device", "other"),
        ] {
            assert!(matches!(
                store
                    .heartbeat_run_lease("org_1", session, "lease", user, device, token, 80, 3)
                    .await,
                Err(StoreError::NotFound)
            ));
            assert!(matches!(
                store
                    .release_run_lease("org_1", session, "lease", user, device, token, 3, "failed")
                    .await,
                Err(StoreError::NotFound)
            ));
        }
        assert!(matches!(
            store
                .heartbeat_run_lease(
                    "org_1",
                    "ses_1",
                    "lease",
                    "usr_owner",
                    "device",
                    "digest",
                    120,
                    50
                )
                .await,
            Err(StoreError::NotFound)
        ));
        // Expired executors may clean up only their own durable lease, without renewing execution.
        let released = store
            .release_run_lease(
                "org_1",
                "ses_1",
                "lease",
                "usr_owner",
                "device",
                "digest",
                101,
                "failed",
            )
            .await
            .unwrap();
        assert_eq!(released.status, "failed");
        assert!(store
            .release_run_lease(
                "org_1",
                "ses_1",
                "lease",
                "usr_owner",
                "device",
                "digest",
                102,
                "failed"
            )
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn session_patch_is_revision_checked_idempotent_and_advances_policy() {
        let store = fixture_store();
        store.create_session(session("op_1")).await.unwrap();
        let active = store
            .patch_session(
                "org_1",
                "ses_1",
                None,
                Some(SessionStatus::Archived),
                None,
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
                    None,
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
                .patch_session(
                    "org_1",
                    "ses_1",
                    Some("stale"),
                    None,
                    None,
                    "op_stale",
                    1,
                    3
                )
                .await,
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn invitation_is_single_use_target_bound_and_guest_capped() {
        let store = fixture_store();
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
        let store = fixture_store();
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
        let store = fixture_store();
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
        assert_eq!(
            store
                .commit_attachment("org_1", "ses_1", "attachment_1", None, 4)
                .await
                .unwrap(),
            available
        );
        assert!(matches!(
            store
                .commit_attachment("org_1", "ses_1", "attachment_1", Some("different-event"), 4)
                .await,
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn queue_claim_is_fifo_idempotent_and_requires_explicit_takeover() {
        let store = fixture_store();
        store.create_session(session("op")).await.unwrap();
        store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "context".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                kind: "message.created".into(),
                actor_kind: "human".into(),
                actor_id: "usr_owner".into(),
                actor_label: None,
                payload: serde_json::json!({"messageId":"m","role":"user","parts":[]}),
                now: 1,
                operation_id: "context".into(),
            })
            .await
            .unwrap();
        for index in 1..=2 {
            store
                .enqueue_run_input(NewChatRunQueueItem {
                    id: format!("q{index}"),
                    org_id: "org_1".into(),
                    workspace_id: "ws_1".into(),
                    session_id: "ses_1".into(),
                    requested_by_user_id: "usr_owner".into(),
                    payload: serde_json::json!({"messageId":"m"}),
                    now: index,
                    operation_id: format!("qop{index}"),
                })
                .await
                .unwrap();
        }
        let lease = NewChatRunLease {
            id: "l1".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            run_id: "r1".into(),
            holder_user_id: "usr_owner".into(),
            holder_device_id: "d1".into(),
            token_hash: "secret".into(),
            token_expires_at: 100,
            heartbeat_expires_at: 100,
            now: 3,
            operation_id: "claim1".into(),
        };
        assert!(matches!(
            store.claim_run_queue(lease.clone(), "q2", false).await,
            Err(StoreError::Conflict(_))
        ));
        let (claimed, item) = store
            .claim_run_queue(lease.clone(), "q1", false)
            .await
            .unwrap();
        assert_eq!(item.status, "claimed");
        assert_eq!(item.payload["contextSequence"], 1);
        assert_eq!(
            store
                .claim_run_queue(lease.clone(), "q1", false)
                .await
                .unwrap()
                .0,
            claimed
        );
        let mut next = lease.clone();
        next.id = "l2".into();
        next.run_id = "r2".into();
        next.operation_id = "claim2".into();
        next.now = 101;
        next.token_expires_at = 200;
        next.heartbeat_expires_at = 200;
        assert!(matches!(
            store.claim_run_queue(next.clone(), "q2", false).await,
            Err(StoreError::Conflict(_))
        ));
        store.claim_run_queue(next, "q2", true).await.unwrap();
        assert!(store
            .validate_run_token("org_1", "ses_1", "r1", "secret", 102)
            .await
            .is_err());
        assert!(store
            .append_session_run_event(
                NewSessionEvent {
                    tool_detail_revision: None,
                    id: "late".into(),
                    org_id: "org_1".into(),
                    workspace_id: "ws_1".into(),
                    session_id: "ses_1".into(),
                    kind: "message.created".into(),
                    actor_kind: "agent".into(),
                    actor_id: "run:r1".into(),
                    actor_label: None,
                    payload: serde_json::json!({}),
                    now: 102,
                    operation_id: "late".into()
                },
                "r1",
                "secret"
            )
            .await
            .is_err());
        assert!(store
            .list_run_queue("org_1", "ses_1")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn run_token_is_bound_and_concurrent_input_is_ordered() {
        let store = fixture_store();
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
        let store = fixture_store();
        store.create_session(session("op_1")).await.unwrap();
        assert!(matches!(
            store.remove_member("org_1", "ses_1", "usr_owner", "usr_owner", 2).await,
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
                "usr_owner",
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
            .remove_member("org_1", "ses_1", "usr_owner", "usr_owner", 4)
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
        let store = fixture_store();
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
