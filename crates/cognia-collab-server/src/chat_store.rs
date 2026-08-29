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

#[async_trait]
pub trait ChatStore: Send + Sync {
    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError>;
    async fn list_sessions(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SharedSession>, StoreError>;
    async fn visible_session(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<(SharedSession, SessionMembership)>, StoreError>;
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
}

#[derive(Default)]
struct MemoryTables {
    sessions: HashMap<String, SharedSession>,
    memberships: HashMap<(String, String), SessionMembership>,
    events: HashMap<String, Vec<SessionEvent>>,
    leases: HashMap<String, (ChatRunLease, String, String)>,
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
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(sessions)
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

    async fn list_members(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<SessionMembership>, StoreError> {
        let tables = self.tables.read();
        if !tables
            .sessions
            .get(session_id)
            .is_some_and(|session| session.org_id == org_id)
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
        for (lease, _, _) in tables.leases.values_mut() {
            if lease.session_id == session_id && lease.holder_user_id == user_id {
                lease.status = "failed".into();
                lease.updated_at = now;
            }
        }
        Ok(())
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
        if !tables
            .sessions
            .get(session_id)
            .is_some_and(|session| session.org_id == org_id)
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

    async fn acquire_run_lease(&self, input: NewChatRunLease) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        if let Some((lease, _, _)) = tables
            .leases
            .values()
            .find(|(_, org, operation)| org == &input.org_id && operation == &input.operation_id)
        {
            return Ok(lease.clone());
        }
        if let Some((lease, _, _)) = tables.leases.values_mut().find(|(lease, _, _)| {
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
        tables
            .leases
            .insert(input.id, (lease.clone(), input.org_id, input.operation_id));
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
        let (lease, stored_org, stored_token) = tables
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
        let (lease, stored_org, _) = tables
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

    async fn acquire_run_lease(&self, input: NewChatRunLease) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row)=tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return Ok(lease_from_row(&row)); }
        tx.execute("UPDATE chat_run_leases SET status='expired',updated_at=$3 WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused') AND heartbeat_expires_at<=$3", &[&input.org_id,&input.session_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        if let Some(row)=tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused')"), &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return Err(conflict(lease_from_row(&row))); }
        let row=tx.query_one(&format!("INSERT INTO chat_run_leases (id,org_id,workspace_id,session_id,run_id,holder_user_id,holder_device_id,status,token_hash,token_expires_at,heartbeat_expires_at,created_at,updated_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$11,$12) RETURNING {LEASE_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.run_id,&input.holder_user_id,&input.holder_device_id,&input.token_hash,&input.token_expires_at,&input.heartbeat_expires_at,&input.now,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
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
        let row=tx.query_opt(&format!("UPDATE chat_run_leases SET heartbeat_expires_at=$6,updated_at=$7 WHERE org_id=$1 AND id=$2 AND holder_user_id=$3 AND holder_device_id=$4 AND token_hash=$5 AND status='active' AND token_expires_at>$7 RETURNING {LEASE_COLUMNS}"), &[&org_id,&lease_id,&holder_user_id,&holder_device_id,&token_hash,&heartbeat_expires_at,&now]).await.map_err(|e|StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
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
}
