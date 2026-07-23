//! Session-scoped credential leases (ADR-0090 Phase 2, R4).
//!
//! Agent sessions default to sticky credentials: once a deployment+credential
//! served a session successfully, later requests keep using it (prompt-cache
//! and provider-side session affinity). Process-local like `KeyRotationMap`;
//! recovery re-establishes leases naturally on the first post-restart
//! request.

use std::collections::HashMap;

use parking_lot::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub struct CredentialLease {
    pub deployment_id: String,
    /// Non-secret credential fingerprint (`credentials::fingerprint_of`).
    pub credential_fingerprint: String,
    pub acquired_at_ms: i64,
}

#[derive(Default)]
pub struct CredentialLeaseMap {
    inner: Mutex<HashMap<String, CredentialLease>>,
}

impl CredentialLeaseMap {
    pub fn get(&self, session_id: &str) -> Option<CredentialLease> {
        self.inner.lock().get(session_id).cloned()
    }

    /// Record (or move) the session's lease. Called on successful attempts;
    /// under `sticky-with-failover` a pre-first-byte failover that succeeds on
    /// another credential MOVES the lease there and sticks.
    pub fn acquire(
        &self,
        session_id: &str,
        deployment_id: &str,
        credential_fingerprint: &str,
        now_ms: i64,
    ) {
        self.inner.lock().insert(
            session_id.to_string(),
            CredentialLease {
                deployment_id: deployment_id.to_string(),
                credential_fingerprint: credential_fingerprint.to_string(),
                acquired_at_ms: now_ms,
            },
        );
    }

    /// Drop a session's lease (revocation / permanent credential failure).
    pub fn release(&self, session_id: &str) {
        self.inner.lock().remove(session_id);
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_get_move_release_round_trip() {
        let leases = CredentialLeaseMap::default();
        assert!(leases.get("s1").is_none());
        assert!(leases.is_empty());

        leases.acquire("s1", "dep-a", "…1111", 100);
        assert_eq!(
            leases.get("s1"),
            Some(CredentialLease {
                deployment_id: "dep-a".into(),
                credential_fingerprint: "…1111".into(),
                acquired_at_ms: 100,
            })
        );

        // Failover success moves the lease.
        leases.acquire("s1", "dep-b", "…2222", 200);
        assert_eq!(leases.get("s1").unwrap().deployment_id, "dep-b");
        assert_eq!(leases.len(), 1);

        leases.release("s1");
        assert!(leases.get("s1").is_none());
        // Releasing twice is idempotent.
        leases.release("s1");
    }
}
