//! Short-lived, device-bound step-up leases for high-risk host operations.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const DEFAULT_TTL_SECONDS: u64 = 10 * 60;
const MAX_TTL_SECONDS: u64 = 30 * 60;

#[derive(Clone)]
struct Lease {
    device_id: String,
    operations: HashSet<String>,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedAdminLease {
    pub token: String,
    pub operations: Vec<String>,
    pub expires_at: u64,
}

static LEASES: Lazy<Mutex<HashMap<String, Lease>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn issue(
    device_id: &str,
    operations: Vec<String>,
    ttl_seconds: Option<u64>,
    confirmed: bool,
    owner_authorized: bool,
) -> Result<IssuedAdminLease, String> {
    if !owner_authorized {
        return Err(
            "REMOTE_SCOPE_DENIED: only an explicitly registered host owner may issue an admin lease"
                .into(),
        );
    }
    if !confirmed {
        return Err(
            "REMOTE_CONSENT_REQUIRED: explicit owner confirmation is required for an admin lease"
                .into(),
        );
    }
    if operations.is_empty()
        || operations
            .iter()
            .any(|operation| operation.trim().is_empty())
    {
        return Err("admin lease operations must not be empty".into());
    }
    let ttl = ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
    if ttl == 0 || ttl > MAX_TTL_SECONDS {
        return Err(format!(
            "admin lease TTL must be between 1 and {MAX_TTL_SECONDS} seconds"
        ));
    }
    let token = format!("lease_{}.{}", Uuid::new_v4(), Uuid::new_v4());
    let expires_at = now_ms().saturating_add(ttl.saturating_mul(1000));
    let mut unique = HashSet::new();
    let mut normalized = Vec::new();
    for operation in operations {
        if unique.insert(operation.clone()) {
            normalized.push(operation);
        }
    }
    LEASES.lock().insert(
        token_hash(&token),
        Lease {
            device_id: device_id.into(),
            operations: unique,
            expires_at,
        },
    );
    Ok(IssuedAdminLease {
        token,
        operations: normalized,
        expires_at,
    })
}

pub fn validate(device_id: &str, operation: &str, token: Option<&str>) -> Result<(), String> {
    let token = token.ok_or_else(|| {
        "REMOTE_CONSENT_REQUIRED: this operation requires a short-lived admin lease".to_string()
    })?;
    let now = now_ms();
    let mut leases = LEASES.lock();
    leases.retain(|_, lease| lease.expires_at > now);
    let lease = leases
        .get(&token_hash(token))
        .ok_or_else(|| "REMOTE_CONSENT_REQUIRED: admin lease is invalid or expired".to_string())?;
    if lease.device_id != device_id {
        return Err("REMOTE_SCOPE_DENIED: admin lease belongs to another device".into());
    }
    if !lease.operations.contains(operation) && !lease.operations.contains("*") {
        return Err("REMOTE_SCOPE_DENIED: admin lease does not cover this operation".into());
    }
    Ok(())
}

pub fn revoke_device(device_id: &str) {
    LEASES
        .lock()
        .retain(|_, lease| lease.device_id != device_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_bound_to_device_operation_and_confirmation() {
        assert!(issue(
            "device-a",
            vec!["skills_install_atomic".into()],
            None,
            false,
            true
        )
        .is_err());
        assert!(issue(
            "device-a",
            vec!["skills_install_atomic".into()],
            None,
            true,
            false
        )
        .is_err());
        let lease = issue(
            "device-a",
            vec!["skills_install_atomic".into()],
            Some(600),
            true,
            true,
        )
        .unwrap();
        assert!(validate("device-a", "skills_install_atomic", Some(&lease.token)).is_ok());
        assert!(validate("device-b", "skills_install_atomic", Some(&lease.token)).is_err());
        assert!(validate("device-a", "external_bridge_start", Some(&lease.token)).is_err());
        revoke_device("device-a");
        assert!(validate("device-a", "skills_install_atomic", Some(&lease.token)).is_err());
    }

    #[test]
    fn ttl_cannot_exceed_thirty_minutes() {
        assert!(issue("device", vec!["*".into()], Some(1801), true, true).is_err());
    }
}
