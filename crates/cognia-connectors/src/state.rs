use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::types::AdapterRegistration;

const RUNTIME_LEASE_MIN_TTL_MS: u64 = 5_000;
const RUNTIME_LEASE_MAX_TTL_MS: u64 = 60_000;
const RUNTIME_LEASE_MAX_OWNER_BYTES: usize = 128;

#[derive(Debug, Clone)]
struct ConnectorRuntimeLease {
    owner_id: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct ConnectorsStateInner {
    pub registered_adapters: HashMap<String, AdapterRegistration>,
    pub server_running: bool,
    pub bound_addr: Option<String>,
    runtime_lease: Option<ConnectorRuntimeLease>,
}

#[derive(Clone, Default)]
pub struct ConnectorsState {
    pub inner: Arc<Mutex<ConnectorsStateInner>>,
}

impl ConnectorsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a clone of self — used when the lifecycle needs to pass state
    /// into the axum server without consuming the managed copy.
    pub fn inner_state(&self) -> Self {
        self.clone()
    }

    /// Acquire or refresh the host-scoped connector-runtime lease.
    ///
    /// The lease lives in the Rust host rather than the renderer, so multiple
    /// Node brain processes and desktop webviews cannot each boot the same
    /// connector transports. An expired lease may be taken over by a new owner.
    pub fn acquire_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.acquire_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Renew an unexpired lease held by `owner_id`.
    pub fn renew_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.renew_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Release the lease only when it belongs to `owner_id`.
    pub fn release_runtime_lease(&self, owner_id: &str) -> Result<bool, String> {
        validate_runtime_lease_owner(owner_id)?;
        let mut inner = self.inner.lock();
        if inner
            .runtime_lease
            .as_ref()
            .is_some_and(|lease| lease.owner_id == owner_id)
        {
            inner.runtime_lease = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn acquire_runtime_lease_at(
        &self,
        owner_id: &str,
        ttl_ms: u64,
        now: Instant,
    ) -> Result<bool, String> {
        validate_runtime_lease(owner_id, ttl_ms)?;
        let expires_at = lease_expiry(now, ttl_ms)?;
        let mut inner = self.inner.lock();
        if inner
            .runtime_lease
            .as_ref()
            .is_some_and(|lease| lease.expires_at > now && lease.owner_id != owner_id)
        {
            return Ok(false);
        }
        inner.runtime_lease = Some(ConnectorRuntimeLease {
            owner_id: owner_id.to_string(),
            expires_at,
        });
        Ok(true)
    }

    fn renew_runtime_lease_at(
        &self,
        owner_id: &str,
        ttl_ms: u64,
        now: Instant,
    ) -> Result<bool, String> {
        validate_runtime_lease(owner_id, ttl_ms)?;
        let expires_at = lease_expiry(now, ttl_ms)?;
        let mut inner = self.inner.lock();
        let Some(lease) = inner.runtime_lease.as_mut() else {
            return Ok(false);
        };
        if lease.expires_at <= now {
            inner.runtime_lease = None;
            return Ok(false);
        }
        if lease.owner_id != owner_id {
            return Ok(false);
        }
        lease.expires_at = expires_at;
        Ok(true)
    }
}

fn validate_runtime_lease(owner_id: &str, ttl_ms: u64) -> Result<(), String> {
    validate_runtime_lease_owner(owner_id)?;
    if !(RUNTIME_LEASE_MIN_TTL_MS..=RUNTIME_LEASE_MAX_TTL_MS).contains(&ttl_ms) {
        return Err(format!(
            "connector runtime lease TTL must be between {RUNTIME_LEASE_MIN_TTL_MS} and {RUNTIME_LEASE_MAX_TTL_MS} ms"
        ));
    }
    Ok(())
}

fn validate_runtime_lease_owner(owner_id: &str) -> Result<(), String> {
    if owner_id.trim().is_empty() || owner_id.len() > RUNTIME_LEASE_MAX_OWNER_BYTES {
        return Err(format!(
            "connector runtime lease owner must be 1-{RUNTIME_LEASE_MAX_OWNER_BYTES} bytes"
        ));
    }
    Ok(())
}

fn lease_expiry(now: Instant, ttl_ms: u64) -> Result<Instant, String> {
    now.checked_add(Duration::from_millis(ttl_ms))
        .ok_or_else(|| "connector runtime lease expiry overflow".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdapterRegistration;

    #[test]
    fn registers_and_unregisters() {
        let s = ConnectorsState::new();
        s.inner.lock().registered_adapters.insert(
            "a".into(),
            AdapterRegistration {
                adapter_id: "a".into(),
                adapter_type: "telegram".into(),
                webhook_path: None,
            },
        );
        assert_eq!(s.inner.lock().registered_adapters.len(), 1);
        s.inner.lock().registered_adapters.remove("a");
        assert_eq!(s.inner.lock().registered_adapters.len(), 0);
    }

    #[test]
    fn runtime_lease_allows_one_owner_until_expiry() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start)
            .unwrap());
        assert!(!state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1))
            .unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start + Duration::from_millis(2))
            .unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(15_003))
            .unwrap());
    }

    #[test]
    fn runtime_lease_renew_and_release_are_owner_bound() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start)
            .unwrap());

        assert!(!state
            .renew_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1_000))
            .unwrap());
        assert!(state
            .renew_runtime_lease_at("brain-a", 15_000, start + Duration::from_millis(1_000))
            .unwrap());
        assert!(!state.release_runtime_lease("brain-b").unwrap());
        assert!(state.release_runtime_lease("brain-a").unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1_001))
            .unwrap());
    }

    #[test]
    fn runtime_lease_rejects_invalid_owner_and_ttl() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert!(state.acquire_runtime_lease_at("", 15_000, start).is_err());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 1_000, start)
            .is_err());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 120_000, start)
            .is_err());
    }
}
