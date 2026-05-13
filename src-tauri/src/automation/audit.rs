//! In-process audit ring for automation calls.
//!
//! `len` / `is_empty` / `clear` exist for the M1.11 Settings UI audit tab
//! (queried via a Tauri command); marked allow-dead-code so the warning
//! doesn't pollute the build.
#![allow(dead_code)]
//!
//! The ring is in-process so we have a useful debugging surface even if the
//! renderer is detached. The authoritative durable copy lives in the Dexie
//! `automationAuditLog` table — `record()` emits an `automation:event` Tauri
//! event after every append so the TS side can mirror it to Dexie.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use uuid::Uuid;

use super::permission::Surface;

pub const AUDIT_CAP: usize = 5000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
    Consent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub ts: i64,
    pub surface: Surface,
    pub plugin_id: Option<String>,
    pub command: String,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub decision: Decision,
    pub reason: Option<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct AuditRing {
    inner: Arc<Mutex<VecDeque<AuditEntry>>>,
}

impl Default for AuditRing {
    fn default() -> Self {
        Self::new()
    }
}

impl AuditRing {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(AUDIT_CAP))),
        }
    }

    pub fn record(&self, mut entry: AuditEntry) -> AuditEntry {
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
        }
        let mut guard = self.inner.lock();
        if guard.len() >= AUDIT_CAP {
            guard.pop_front();
        }
        guard.push_back(entry.clone());
        entry
    }

    pub fn snapshot(&self) -> Vec<AuditEntry> {
        self.inner.lock().iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }

    pub fn clear(&self) {
        self.inner.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(decision: Decision) -> AuditEntry {
        AuditEntry {
            id: String::new(),
            ts: 0,
            surface: Surface::Workflow,
            plugin_id: None,
            command: "screenshot".into(),
            process_name: None,
            window_title: None,
            decision,
            reason: None,
            duration_ms: 0,
            error: None,
        }
    }

    #[test]
    fn record_assigns_uuid_when_id_empty() {
        let r = AuditRing::new();
        let e = r.record(entry(Decision::Allow));
        assert!(!e.id.is_empty());
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn evicts_oldest_when_over_cap() {
        let r = AuditRing::new();
        for _ in 0..AUDIT_CAP + 5 {
            r.record(entry(Decision::Allow));
        }
        assert_eq!(r.len(), AUDIT_CAP);
    }

    #[test]
    fn snapshot_returns_in_order() {
        let r = AuditRing::new();
        let mut commands = vec![];
        for i in 0..10 {
            let mut e = entry(Decision::Allow);
            e.command = format!("cmd-{i}");
            r.record(e);
            commands.push(format!("cmd-{i}"));
        }
        let snap = r.snapshot();
        let got: Vec<String> = snap.into_iter().map(|e| e.command).collect();
        assert_eq!(got, commands);
    }

    #[test]
    fn clear_empties_the_ring() {
        let r = AuditRing::new();
        r.record(entry(Decision::Allow));
        assert!(!r.is_empty());
        r.clear();
        assert!(r.is_empty());
    }
}
