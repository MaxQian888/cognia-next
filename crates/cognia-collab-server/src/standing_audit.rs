//! Operator inventory and bounded repair of legacy shared-session standing.
//! Separate from the HTTP server: this scans all tenants and therefore needs
//! a database role allowed to bypass RLS (never silently report an empty scan).

use crate::chat::SessionMembership;
use crate::chat_store::{effective_member_from_row, member_from_row, pg_cleanup_member, MEMBER_COLUMNS, MEMBER_JOINS};
use crate::store::{PgStore, StoreError};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingIssue {
    pub org_id: String,
    pub session_id: String,
    pub user_id: String,
    pub reason: &'static str,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingAudit {
    pub scanned: usize,
    pub missing_standing: usize,
    pub exceeds_ceiling: usize,
    pub applied: usize,
    pub issues: Vec<StandingIssue>,
}

pub(crate) fn standing_issue(member: &SessionMembership, effective: Option<&SessionMembership>) -> Option<&'static str> {
    if member.guest { return None; }
    match effective {
        None => Some("missing_standing"),
        Some(effective) if member.role != effective.role || member.approver != effective.approver => Some("exceeds_ceiling"),
        _ => None,
    }
}

impl StandingAudit {
    pub(crate) fn record(&mut self, org_id: &str, member: &SessionMembership, effective: Option<&SessionMembership>) -> bool {
        self.scanned += 1;
        let Some(reason) = standing_issue(member, effective) else { return false };
        if reason == "missing_standing" { self.missing_standing += 1; } else { self.exceeds_ceiling += 1; }
        self.issues.push(StandingIssue {
            org_id: org_id.to_owned(), session_id: member.session_id.clone(), user_id: member.user_id.clone(), reason,
        });
        true
    }
}

pub async fn audit_standing(store: &PgStore, apply: bool, batch_size: usize, now: i64) -> Result<StandingAudit, StoreError> {
    if batch_size == 0 || batch_size > 10_000 {
        return Err(StoreError::Policy("batch-size must be between 1 and 10000".into()));
    }
    let mut report = StandingAudit::default();
    let mut cursor = (String::new(), String::new());
    loop {
        let mut client = store.client().await?;
        let tx = client.transaction().await.map_err(|e| StoreError::Database(e.to_string()))?;
        // With an ordinary tenant role PostgreSQL errors instead of filtering
        // this cross-tenant inventory, which would hide precisely the stale rows.
        tx.batch_execute("SET LOCAL row_security = off").await.map_err(|e| StoreError::Database(e.to_string()))?;
        let lock = if apply { " FOR UPDATE OF s" } else { "" };
        let rows = tx.query(&format!("SELECT m.org_id, {MEMBER_COLUMNS}, om.role AS org_role, wm.role AS workspace_role {MEMBER_JOINS} WHERE NOT m.guest AND (s.id,m.user_id)>($1,$2) ORDER BY s.id,m.user_id LIMIT $3{lock}"), &[&cursor.0,&cursor.1,&(batch_size as i64)]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        if rows.is_empty() { break; }
        for row in rows {
            let member = member_from_row(&row)?;
            let org_id: String = row.get("org_id");
            cursor = (member.session_id.clone(), member.user_id.clone());
            let effective = effective_member_from_row(&row)?;
            if report.record(&org_id, &member, effective.as_ref()) && apply
                && pg_cleanup_member(&tx, &org_id, &member.session_id, &member.user_id, false, false, now).await? {
                report.applied += 1;
            }
        }
        tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{cap_session_member, SessionRole};
    use cognia_tenant_auth::{membership::resolve_workspace_access, OrgRole, WorkspaceRole};

    #[test]
    fn inventory_distinguishes_missing_and_excess_standing_and_exempts_guests() {
        let mut member = SessionMembership {
            session_id: "session".into(), user_id: "user".into(), role: SessionRole::Maintainer,
            approver: true, guest: false, display_name: None, created_at: 1, updated_at: 1,
        };
        assert_eq!(standing_issue(&member, None), Some("missing_standing"));
        let viewer = cap_session_member(member.clone(), resolve_workspace_access(Some(OrgRole::Member), Some(WorkspaceRole::Viewer))).unwrap();
        assert_eq!(standing_issue(&member, Some(&viewer)), Some("exceeds_ceiling"));
        assert!(!viewer.approver);
        assert_eq!(standing_issue(&viewer, Some(&viewer)), None);
        member.guest = true;
        assert_eq!(standing_issue(&member, None), None);
    }
}
