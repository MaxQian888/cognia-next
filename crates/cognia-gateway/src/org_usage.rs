//! Monthly member accounting, owned by the gateway so ticket and member holds
//! share one lock. Separate from route_ticket to keep the persistence port and
//! calendar/cap rules independently testable; no identity service dependency.
use std::collections::BTreeMap;
use chrono::{Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use crate::route_ticket::TicketReject;

pub const SERVICE: &str = "com.cognia.host-org-member-usage/v1";
/// JS-safe, bounded monthly token value, shared with the request contract.
pub const MAX_MONTHLY_TOKENS: u64 = 1_000_000_000_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberBinding { pub org_id: String, pub user_id: String }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage { pub reserved: u64, pub spent: u64 }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OrgUsage {
    pub default_monthly_tokens: Option<u64>,
    /// Missing => default; None => explicitly unlimited.
    pub overrides: BTreeMap<String, Option<u64>>,
    pub months: BTreeMap<String, BTreeMap<String, Usage>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MemberUsageLedger { pub orgs: BTreeMap<String, OrgUsage> }

/// Usage is dirty-flushed by RouteTicketRegistry::flush at the gateway's 60s
/// periodic flush and on shutdown. A crash can lose usage since the last
/// successful flush (at most 60s during healthy storage/scheduling; storage
/// failures extend that window). Caps are synchronous. Persisted orphan holds
/// are conservatively charged as spent on restart, never silently refunded.
pub trait MemberUsageStore: Send + Sync + 'static {
    fn load(&self) -> Result<MemberUsageLedger, String>;
    fn save_org(&self, org: &str, usage: &OrgUsage) -> Result<(), String>;
}

#[derive(Default)]
pub struct InMemoryMemberUsageStore(parking_lot::Mutex<MemberUsageLedger>);
impl MemberUsageStore for InMemoryMemberUsageStore {
    fn load(&self) -> Result<MemberUsageLedger, String> { Ok(self.0.lock().clone()) }
    fn save_org(&self, org: &str, usage: &OrgUsage) -> Result<(), String> {
        self.0.lock().orgs.insert(org.into(), usage.clone()); Ok(())
    }
}

/// The gateway is a domain crate already depending on foundation cognia-secrets
/// (rust-architecture.json). User ids remain inside sealed secret_store values;
/// only the org id is the account. Never registered in host_secrets.
pub struct SealedMemberUsageStore;
impl MemberUsageStore for SealedMemberUsageStore {
    fn load(&self) -> Result<MemberUsageLedger, String> {
        let mut ledger = MemberUsageLedger::default();
        for org in cognia_secrets::secret_store::list_accounts(SERVICE)? {
            let raw = cognia_secrets::secret_store::get(SERVICE, &org)?.ok_or("organization usage store unavailable")?;
            let usage = serde_json::from_str(&raw).map_err(|_| "organization usage store unavailable")?;
            ledger.orgs.insert(org, usage);
        }
        Ok(ledger)
    }
    fn save_org(&self, org: &str, usage: &OrgUsage) -> Result<(), String> {
        let raw = serde_json::to_string(usage).map_err(|_| "organization usage store unavailable")?;
        cognia_secrets::secret_store::set(SERVICE, org, &raw).map_err(|_| "organization usage store unavailable".into())
    }
}

pub fn month_at(now_ms: i64) -> String {
    Utc.timestamp_millis_opt(now_ms).single().expect("UTC milliseconds in supported range").format("%Y-%m").to_string()
}
pub fn reset_at(month: &str) -> i64 {
    let date = chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").expect("validated month");
    let (year, next) = if date.month() == 12 { (date.year() + 1, 1) } else { (date.year(), date.month() + 1) };
    Utc.with_ymd_and_hms(year, next, 1, 0, 0, 0).single().expect("next UTC month").timestamp_millis()
}
pub fn valid_month(month: &str) -> bool {
    month.len() == 7 && month.as_bytes()[4] == b'-' && month.bytes().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
        && chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").is_ok()
}
impl OrgUsage {
    pub fn effective_cap(&self, user: &str) -> Option<u64> { self.overrides.get(user).copied().unwrap_or(self.default_monthly_tokens) }
}
impl MemberUsageLedger {
    pub fn check(&self, member: &MemberBinding, month: &str, additional: u64) -> Result<(), TicketReject> {
        let Some(org) = self.orgs.get(&member.org_id) else { return Ok(()) };
        let row = org.months.get(month).and_then(|rows| rows.get(&member.user_id));
        let total = row.map_or(0, |row| row.spent.saturating_add(row.reserved));
        if org.effective_cap(&member.user_id).is_some_and(|cap| total.saturating_add(additional) > cap) {
            return Err(TicketReject::MemberUsageCapReached { reset_at: reset_at(month) });
        }
        Ok(())
    }
    pub fn row_mut(&mut self, member: &MemberBinding, month: &str) -> &mut Usage {
        self.orgs.entry(member.org_id.clone()).or_default().months.entry(month.into()).or_default().entry(member.user_id.clone()).or_default()
    }
    /// Reads never insert a row. Known fleet people and overrides appear at zero.
    pub fn report(&self, org: &str, month: &str, people: &[String]) -> serde_json::Value {
        let empty = OrgUsage::default();
        let usage = self.orgs.get(org).unwrap_or(&empty);
        let mut users: std::collections::BTreeSet<&String> = people.iter().chain(usage.overrides.keys()).collect();
        for rows in usage.months.values() { users.extend(rows.keys()); }
        let members: Vec<_> = users.into_iter().map(|user| {
            let row = usage.months.get(month).and_then(|rows| rows.get(user));
            serde_json::json!({ "userId": user, "spentTokens": row.map_or(0, |r| r.spent), "reservedTokens": row.map_or(0, |r| r.reserved),
                "monthlyTokens": usage.effective_cap(user), "capSource": if usage.overrides.contains_key(user) { "override" } else { "default" } })
        }).collect();
        serde_json::json!({ "month": month, "defaultMonthlyTokens": usage.default_monthly_tokens, "members": members })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p6b_sealed_store_survives_restart_in_own_namespace() {
        let org = "org_p6b_sealed_restart";
        let reg = crate::route_ticket::RouteTicketRegistry::new(std::sync::Arc::new(crate::route_ticket::InMemoryTicketMetaStore::default()));
        reg.attach_usage_store(std::sync::Arc::new(SealedMemberUsageStore)).unwrap();
        reg.org_usage_cap_set(org, None, Some(Some(42))).unwrap();
        reg.org_usage_cap_set(org, Some("usr_p6b_sealed"), Some(None)).unwrap();
        let store = SealedMemberUsageStore;
        let mut usage = store.load().unwrap().orgs[org].clone();
        usage.months.entry("2026-10".into()).or_default().insert("usr_p6b_sealed".into(), Usage { reserved: 0, spent: 17 });
        store.save_org(org, &usage).unwrap();
        let restarted = SealedMemberUsageStore.load().unwrap();
        assert_eq!(restarted.orgs[org].default_monthly_tokens, Some(42));
        assert_eq!(restarted.orgs[org].overrides["usr_p6b_sealed"], None);
        assert_eq!(restarted.orgs[org].months["2026-10"]["usr_p6b_sealed"].spent, 17);
        assert!(cognia_secrets::secret_store::list_accounts(SERVICE).unwrap().contains(&org.into()));
        assert!(!cognia_secrets::host_secrets::list().unwrap().iter().any(|row| row.name == org));
        cognia_secrets::secret_store::delete(SERVICE, org).unwrap();
    }

    #[test]
    fn p6b_override_precedence_and_reads_do_not_create_rows() {
        let mut ledger = MemberUsageLedger::default();
        assert_eq!(ledger.report("org_test", "2026-10", &[])["members"], serde_json::json!([]));
        assert!(ledger.orgs.is_empty());
        let org = ledger.orgs.entry("org_test".into()).or_default();
        assert_eq!(org.effective_cap("usr_a"), None);
        org.default_monthly_tokens = Some(100);
        assert_eq!(org.effective_cap("usr_a"), Some(100));
        org.overrides.insert("usr_a".into(), Some(20));
        assert_eq!(org.effective_cap("usr_a"), Some(20));
        org.overrides.insert("usr_a".into(), None);
        assert_eq!(org.effective_cap("usr_a"), None);
        org.overrides.remove("usr_a");
        assert_eq!(org.effective_cap("usr_a"), Some(100));
        ledger.report("org_test", "2026-11", &["usr_a".into()]);
        assert!(ledger.orgs["org_test"].months.is_empty());
        assert_eq!(reset_at("2026-12"), Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap().timestamp_millis());
        assert_eq!(reset_at("2028-02"), Utc.with_ymd_and_hms(2028, 3, 1, 0, 0, 0).unwrap().timestamp_millis());
        for invalid in ["2026-13", "2026-1", "garbage", "２０２６-10"] { assert!(!valid_month(invalid)); }
    }
}
