use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::types::AdapterRegistration;

const RUNTIME_LEASE_MIN_TTL_MS: u64 = 5_000;
const RUNTIME_LEASE_MAX_TTL_MS: u64 = 60_000;
const RUNTIME_LEASE_MAX_OWNER_BYTES: usize = 128;

/// Which kind of process holds (or wants) the runtime lease.
///
/// Encoded as the owner-id prefix the callers already use (`brain:<uuid>` /
/// `desktop:<uuid>`) so no separate field has to travel the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeOwnerClass {
    /// A desktop webview runtime. Intermittent by nature — the machine sleeps,
    /// the window closes — so it yields to an always-on brain.
    Desktop,
    /// A `cognia-agent serve` brain process, local or in the cloud.
    Brain,
}

/// Classify an owner id. Anything unprefixed is treated as `Desktop`, the
/// lower-priority class: an unrecognised owner must never be able to evict a
/// brain by accident.
pub fn runtime_owner_class(owner_id: &str) -> RuntimeOwnerClass {
    if owner_id.starts_with("brain:") {
        RuntimeOwnerClass::Brain
    } else {
        RuntimeOwnerClass::Desktop
    }
}

#[derive(Debug, Clone)]
struct ConnectorRuntimeLease {
    owner_id: String,
    expires_at: Instant,
    pending_handoff: Option<PendingRuntimeHandoff>,
}

#[derive(Debug, Clone)]
struct PendingRuntimeHandoff {
    owner_id: String,
    ttl_ms: u64,
    expires_at: Instant,
}

/// Result of a lease claim. Kept separate from the legacy boolean command so
/// handoff-aware callers can wait for the old runtime to acknowledge shutdown
/// without changing the wire shape older callers already consume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeLeaseAcquireOutcome {
    Acquired,
    Busy,
    HandoffPending,
}

impl RuntimeLeaseAcquireOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Acquired => "acquired",
            Self::Busy => "busy",
            Self::HandoffPending => "handoff-pending",
        }
    }
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
    ///
    /// This is the legacy, boolean seam. It is deliberately non-preemptive:
    /// callers that cannot observe `HandoffPending` also cannot participate in
    /// acknowledged teardown, so a failed claim must have no side effects on
    /// the current holder. Handoff-aware callers use
    /// [`Self::acquire_runtime_lease_outcome`].
    pub fn acquire_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.acquire_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Acquire with an observable handoff result for callers that can wait for
    /// a preempted desktop to acknowledge shutdown.
    pub fn acquire_runtime_lease_outcome(
        &self,
        owner_id: &str,
        ttl_ms: u64,
    ) -> Result<RuntimeLeaseAcquireOutcome, String> {
        self.acquire_runtime_lease_outcome_at(owner_id, ttl_ms, Instant::now())
    }

    /// Renew an unexpired lease held by `owner_id`.
    pub fn renew_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.renew_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Release the lease only when it belongs to `owner_id`.
    pub fn release_runtime_lease(&self, owner_id: &str) -> Result<bool, String> {
        self.release_runtime_lease_at(owner_id, Instant::now())
    }

    fn release_runtime_lease_at(&self, owner_id: &str, now: Instant) -> Result<bool, String> {
        validate_runtime_lease_owner(owner_id)?;
        let mut inner = self.inner.lock();
        let Some(lease) = inner.runtime_lease.as_mut() else {
            return Ok(false);
        };
        if lease.owner_id == owner_id {
            if let Some(pending) = lease
                .pending_handoff
                .take()
                .filter(|pending| pending.expires_at > now)
            {
                lease.owner_id = pending.owner_id;
                lease.expires_at = lease_expiry(now, pending.ttl_ms)?;
            } else {
                inner.runtime_lease = None;
            }
            return Ok(true);
        }
        if lease
            .pending_handoff
            .as_ref()
            .is_some_and(|pending| pending.owner_id == owner_id)
        {
            lease.pending_handoff = None;
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
        let Some(lease) = inner.runtime_lease.as_mut() else {
            inner.runtime_lease = Some(ConnectorRuntimeLease {
                owner_id: owner_id.to_string(),
                expires_at,
                pending_handoff: None,
            });
            return Ok(true);
        };

        if lease.expires_at <= now {
            if let Some(pending) = lease
                .pending_handoff
                .take()
                .filter(|pending| pending.expires_at > now)
            {
                if pending.owner_id != owner_id {
                    lease.pending_handoff = Some(pending);
                    return Ok(false);
                }
            }
            lease.owner_id = owner_id.to_string();
            lease.expires_at = expires_at;
            lease.pending_handoff = None;
            return Ok(true);
        }

        if lease.owner_id != owner_id || lease.pending_handoff.is_some() {
            return Ok(false);
        }
        lease.expires_at = expires_at;
        Ok(true)
    }

    fn acquire_runtime_lease_outcome_at(
        &self,
        owner_id: &str,
        ttl_ms: u64,
        now: Instant,
    ) -> Result<RuntimeLeaseAcquireOutcome, String> {
        validate_runtime_lease(owner_id, ttl_ms)?;
        let expires_at = lease_expiry(now, ttl_ms)?;
        let want = runtime_owner_class(owner_id);
        let mut inner = self.inner.lock();
        let Some(lease) = inner.runtime_lease.as_mut() else {
            inner.runtime_lease = Some(ConnectorRuntimeLease {
                owner_id: owner_id.to_string(),
                expires_at,
                pending_handoff: None,
            });
            return Ok(RuntimeLeaseAcquireOutcome::Acquired);
        };

        if lease.expires_at <= now {
            if let Some(pending) = lease
                .pending_handoff
                .take()
                .filter(|pending| pending.expires_at > now)
            {
                if pending.owner_id != owner_id {
                    lease.pending_handoff = Some(pending);
                    return Ok(RuntimeLeaseAcquireOutcome::Busy);
                }
            }
            lease.owner_id = owner_id.to_string();
            lease.expires_at = expires_at;
            lease.pending_handoff = None;
            return Ok(RuntimeLeaseAcquireOutcome::Acquired);
        }

        if lease.owner_id == owner_id {
            if lease.pending_handoff.is_some() {
                return Ok(RuntimeLeaseAcquireOutcome::Busy);
            }
            lease.expires_at = expires_at;
            return Ok(RuntimeLeaseAcquireOutcome::Acquired);
        }

        if let Some(pending) = lease.pending_handoff.as_mut() {
            if pending.expires_at <= now {
                lease.pending_handoff = None;
            } else if pending.owner_id == owner_id {
                pending.ttl_ms = ttl_ms;
                pending.expires_at = expires_at;
                return Ok(RuntimeLeaseAcquireOutcome::HandoffPending);
            } else {
                return Ok(RuntimeLeaseAcquireOutcome::Busy);
            }
        }

        if want > runtime_owner_class(&lease.owner_id) {
            lease.pending_handoff = Some(PendingRuntimeHandoff {
                owner_id: owner_id.to_string(),
                ttl_ms,
                expires_at,
            });
            return Ok(RuntimeLeaseAcquireOutcome::HandoffPending);
        }
        Ok(RuntimeLeaseAcquireOutcome::Busy)
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
        // A preempted owner learns it lost here: renew answers false and the
        // caller tears its transports down, exactly as on TTL loss.
        if lease.expires_at <= now {
            if let Some(pending) = lease
                .pending_handoff
                .take()
                .filter(|pending| pending.expires_at > now)
            {
                lease.owner_id = pending.owner_id;
                lease.expires_at = lease_expiry(now, pending.ttl_ms)?;
            } else {
                inner.runtime_lease = None;
            }
            return Ok(false);
        }
        if lease.owner_id != owner_id {
            return Ok(false);
        }
        if lease.pending_handoff.is_some() {
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
    fn owner_class_is_read_off_the_id_prefix_and_defaults_to_desktop() {
        assert_eq!(runtime_owner_class("brain:abc"), RuntimeOwnerClass::Brain);
        assert_eq!(
            runtime_owner_class("desktop:abc"),
            RuntimeOwnerClass::Desktop
        );
        // Anything unrecognised is the LOWER class — an owner id we cannot
        // classify must never be able to evict a running brain by accident.
        for unknown in ["brain-a", "", "Brain:abc", "cli:abc"] {
            assert_eq!(runtime_owner_class(unknown), RuntimeOwnerClass::Desktop);
        }
        assert!(RuntimeOwnerClass::Brain > RuntimeOwnerClass::Desktop);
    }

    #[test]
    fn a_brain_waits_for_a_live_desktop_to_acknowledge_handoff() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        // Desktop boots first and holds a live lease.
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at("desktop:one", 15_000, start)
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Acquired
        );
        // The brain reserves the handoff but may not start while the desktop
        // transports are still live.
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(1),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::HandoffPending
        );
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(2),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::HandoffPending
        );

        // The desktop observes the reservation through its existing renewal
        // seam and tears its runtime down before releasing.
        assert!(!state
            .renew_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(2))
            .unwrap());
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(3),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::HandoffPending
        );
        assert!(state
            .release_runtime_lease_at("desktop:one", start + Duration::from_millis(4))
            .unwrap());

        // Only the acknowledged handoff lets the brain start.
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(5),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Acquired
        );
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "desktop:one",
                    15_000,
                    start + Duration::from_millis(6),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Busy
        );
    }

    #[test]
    fn legacy_acquire_does_not_reserve_or_preempt_a_live_holder() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert!(state
            .acquire_runtime_lease_at("desktop:one", 15_000, start)
            .unwrap());
        assert!(!state
            .acquire_runtime_lease_at("brain:legacy", 15_000, start + Duration::from_millis(1))
            .unwrap());

        // A legacy caller cannot participate in acknowledged handoff, so its
        // failed claim must leave the current holder completely untouched.
        assert!(state
            .renew_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(2),)
            .unwrap());
    }

    #[test]
    fn expired_holder_renew_promotes_a_live_pending_handoff() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at("desktop:one", 5_000, start)
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Acquired
        );
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(1),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::HandoffPending
        );

        // The old holder can wake after its TTL and attempt one late renew.
        // That must not erase the still-live brain reservation.
        assert!(!state
            .renew_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(5_001),)
            .unwrap());
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "desktop:two",
                    15_000,
                    start + Duration::from_millis(5_002),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Busy
        );
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:one",
                    15_000,
                    start + Duration::from_millis(5_003),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Acquired
        );
    }

    #[test]
    fn a_desktop_takes_over_once_the_brain_lease_expires() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain:one", 15_000, start)
            .unwrap());
        // Priority only applies to a LIVE lease; a brain that stopped
        // renewing must not strand the bots forever.
        assert!(state
            .acquire_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(15_001))
            .unwrap());
    }

    #[test]
    fn two_brains_still_contend_first_come_first_served() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain:one", 15_000, start)
            .unwrap());
        // Same class → no preemption, or two cloud replicas would flap the
        // lease between them on every renew interval.
        assert_eq!(
            state
                .acquire_runtime_lease_outcome_at(
                    "brain:two",
                    15_000,
                    start + Duration::from_millis(1),
                )
                .unwrap(),
            RuntimeLeaseAcquireOutcome::Busy
        );
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
