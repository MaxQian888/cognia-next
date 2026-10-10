//! The durable audit log (ADR-0222 §4.3).
//!
//! Every grant change and every gateway decision is one row: who
//! (`owner`, `credential:<username>`, `member:<user id>`), over which channel, what, on which
//! FileSpace path, with what outcome and why. Rows are kept for
//! [`RETENTION_MS`] and pruned by the maintenance loop. Writing an audit row
//! never fails the operation it describes; a write error is logged instead.

use crate::store::{AuditRow, Store};

/// How long audit rows are kept.
pub const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// The principal string for the local owner acting through the app.
pub const OWNER: &str = "owner";

/// Where an audited action arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    App,
    Webdav,
    Sftp,
    Sftpgo,
    /// A member's request relayed by the collaboration server.
    Collab,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::App => "app",
            Channel::Webdav => "webdav",
            Channel::Sftp => "sftp",
            Channel::Sftpgo => "sftpgo",
            Channel::Collab => "collab",
        }
    }
}

/// How an audited action ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Allowed,
    Denied,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Allowed => "allowed",
            Outcome::Denied => "denied",
            Outcome::Failed => "failed",
        }
    }
}

/// One event to record.
#[derive(Debug, Clone, Default)]
pub struct Event<'a> {
    pub session_id: Option<&'a str>,
    pub grant_id: Option<&'a str>,
    pub principal: &'a str,
    pub channel: Option<Channel>,
    pub action: &'a str,
    pub path: Option<&'a str>,
    pub bytes: Option<i64>,
    pub outcome: Option<Outcome>,
    pub reason: Option<&'a str>,
    pub remote: Option<&'a str>,
}

/// The principal string for a credential holder.
pub fn credential_principal(username: &str) -> String {
    format!("credential:{username}")
}

/// The principal string for a shared conversation's member.
pub fn member_principal(user_id: &str) -> String {
    format!("member:{user_id}")
}

/// Record `event` at `now`.
pub fn record(store: &Store, now: i64, event: Event<'_>) {
    let row = AuditRow {
        id: 0,
        at: now,
        session_id: event.session_id.map(str::to_string),
        grant_id: event.grant_id.map(str::to_string),
        principal: event.principal.to_string(),
        channel: event.channel.unwrap_or(Channel::App).as_str().to_string(),
        action: event.action.to_string(),
        path: event.path.map(str::to_string),
        bytes: event.bytes,
        outcome: event.outcome.unwrap_or(Outcome::Allowed).as_str().to_string(),
        reason: event.reason.map(str::to_string),
        remote: event.remote.map(str::to_string),
    };
    if let Err(error) = store.insert_audit(&row) {
        log::warn!("file-share audit write failed for {}: {error}", row.action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_default_to_an_allowed_app_action() {
        let store = Store::open_in_memory().unwrap();
        record(
            &store,
            42,
            Event {
                session_id: Some("s1"),
                principal: OWNER,
                action: "grant.create",
                ..Event::default()
            },
        );
        record(
            &store,
            43,
            Event {
                session_id: Some("s1"),
                grant_id: Some("fg_1"),
                principal: &credential_principal("cg-abc"),
                channel: Some(Channel::Webdav),
                action: "fs.read",
                path: Some("/workspace/.env"),
                outcome: Some(Outcome::Denied),
                reason: Some("sensitive"),
                remote: Some("10.0.0.2"),
                ..Event::default()
            },
        );
        let rows = store.list_audit(Some("s1"), None, None, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].principal, "credential:cg-abc");
        assert_eq!(rows[0].channel, "webdav");
        assert_eq!(rows[0].outcome, "denied");
        assert_eq!(rows[0].reason.as_deref(), Some("sensitive"));
        assert_eq!(rows[1].channel, "app");
        assert_eq!(member_principal("usr_a"), "member:usr_a");
        assert_eq!(Channel::Collab.as_str(), "collab");
        assert_eq!(rows[1].outcome, "allowed");
    }
}
