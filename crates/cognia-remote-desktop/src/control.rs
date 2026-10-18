//! In-memory principal-bound leases and single-use frame proofs.
//! Callers own authorization, target identity, quiescence and error mapping.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const LEASE_MS: i64 = 15_000;
pub const FRAME_MS: i64 = 5_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLease {
    pub token: String,
    pub fence: u64,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub dto: ControlLease,
    pub principal: String,
    pub deadline: Instant,
    pub epoch: u64,
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub id: String,
    pub fence: u64,
    pub deadline: Instant,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameProof {
    pub frame_id: String,
    pub fence: u64,
    pub expires_at: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlError {
    LeaseExpired,
    StaleFrame,
    ObserverLimit,
    FrameLimit,
}

pub struct ControlStatus<'a> {
    pub fence: u64,
    pub lease: Option<&'a Lease>,
}

/// Unexpired proofs one principal may hold. At 1 Hz polling a five-second
/// window needs at most six, so eight covers one viewer per principal.
pub const FRAMES_PER_PRINCIPAL: usize = 8;

pub struct ControlLeaseCore {
    pub lease: Option<Lease>,
    pub frames: BTreeMap<String, Vec<Frame>>,
    pub fence: u64,
    pub revoked: Arc<AtomicU64>,
    frames_per_principal: usize,
}

impl Default for ControlLeaseCore {
    fn default() -> Self {
        Self::with_frame_limit(FRAMES_PER_PRINCIPAL)
    }
}

impl ControlLeaseCore {
    /// A Host whose several viewers share one principal (the client-local
    /// desktop owner) raises the per-principal cap instead of letting one
    /// viewer's polling refuse another's.
    pub fn with_frame_limit(frames_per_principal: usize) -> Self {
        Self {
            lease: None,
            frames: BTreeMap::new(),
            fence: 0,
            revoked: Arc::new(AtomicU64::new(0)),
            frames_per_principal: frames_per_principal.max(1),
        }
    }

    pub fn invalidate(&mut self) {
        self.fence = self.fence.saturating_add(1);
        self.lease = None;
        self.frames.clear();
    }

    /// Return the invalidated lease so the Host can audit observed expiry.
    pub fn expire(&mut self) -> Option<Lease> {
        if self.lease.as_ref().is_some_and(|lease| {
            Instant::now() >= lease.deadline || self.revoked.load(Ordering::SeqCst) != lease.epoch
        }) {
            let expired = self.lease.take();
            self.invalidate();
            expired
        } else {
            None
        }
    }

    /// `ttl_cap` is the resource's absolute wall-clock deadline in milliseconds.
    pub fn issue(&mut self, principal: &str, now: i64, ttl_cap: i64) -> ControlLease {
        self.invalidate();
        let ttl = LEASE_MS.min(ttl_cap.saturating_sub(now)).max(0);
        let dto = ControlLease {
            token: Uuid::new_v4().to_string(),
            fence: self.fence,
            expires_at: now.saturating_add(ttl),
        };
        self.lease = Some(Lease {
            dto: dto.clone(),
            principal: principal.into(),
            deadline: Instant::now() + Duration::from_millis(ttl as u64),
            epoch: self.revoked.load(Ordering::SeqCst),
        });
        dto
    }

    pub fn require_lease(
        &mut self,
        principal: &str,
        token: &str,
        fence: u64,
    ) -> Result<(), ControlError> {
        self.expire();
        if self.lease.as_ref().is_some_and(|lease| {
            lease.principal == principal
                && lease.dto.token == token
                && lease.dto.fence == fence
                && self.fence == fence
        }) {
            Ok(())
        } else {
            Err(ControlError::LeaseExpired)
        }
    }

    pub fn renew(
        &mut self,
        principal: &str,
        token: &str,
        fence: u64,
        now: i64,
        ttl_cap: i64,
    ) -> Result<ControlLease, ControlError> {
        self.require_lease(principal, token, fence)?;
        let ttl = LEASE_MS.min(ttl_cap.saturating_sub(now)).max(0);
        let lease = self.lease.as_mut().expect("validated lease");
        lease.deadline = Instant::now() + Duration::from_millis(ttl as u64);
        lease.dto.expires_at = now.saturating_add(ttl);
        Ok(lease.dto.clone())
    }

    pub fn register_frame(
        &mut self,
        principal: &str,
        now: i64,
        ttl_cap: i64,
        width: u32,
        height: u32,
    ) -> Result<FrameProof, ControlError> {
        self.frames.retain(|_, frames| {
            frames.retain(|frame| Instant::now() < frame.deadline);
            !frames.is_empty()
        });
        if self.frames.len() >= 32 && !self.frames.contains_key(principal) {
            return Err(ControlError::ObserverLimit);
        }
        let frames = self.frames.entry(principal.into()).or_default();
        // Keep visible prior frames until expiry. Excess polling must not evict them.
        if frames.len() >= self.frames_per_principal {
            return Err(ControlError::FrameLimit);
        }
        let ttl = FRAME_MS.min(ttl_cap.saturating_sub(now)).max(0);
        let frame_id = Uuid::new_v4().to_string();
        frames.push(Frame {
            id: frame_id.clone(),
            fence: self.fence,
            deadline: Instant::now() + Duration::from_millis(ttl as u64),
            width,
            height,
        });
        Ok(FrameProof {
            frame_id,
            fence: self.fence,
            expires_at: now.saturating_add(ttl),
        })
    }

    /// Inspect before validation; invalid input must not consume a valid proof.
    pub fn frame(
        &self,
        principal: &str,
        frame_id: &str,
        fence: u64,
    ) -> Result<&Frame, ControlError> {
        self.frames
            .get(principal)
            .and_then(|frames| {
                frames.iter().find(|frame| {
                    frame.id == frame_id
                        && frame.fence == fence
                        && self.fence == fence
                        && Instant::now() < frame.deadline
                })
            })
            .ok_or(ControlError::StaleFrame)
    }

    /// Every mutation consumes all outstanding proofs, even if its outcome is uncertain.
    pub fn take_frame(
        &mut self,
        principal: &str,
        frame_id: &str,
        fence: u64,
    ) -> Result<Frame, ControlError> {
        let frame = self.frame(principal, frame_id, fence)?.clone();
        self.frames.clear();
        Ok(frame)
    }

    pub fn status(&self) -> ControlStatus<'_> {
        ControlStatus {
            fence: self.fence,
            lease: self.lease.as_ref().filter(|lease| {
                Instant::now() < lease.deadline
                    && self.revoked.load(Ordering::SeqCst) == lease.epoch
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leases_bind_principal_token_fence_epoch_and_expire() {
        let mut core = ControlLeaseCore::default();
        let lease = core.issue("human", 1000, 60000);
        assert_eq!(lease.expires_at, 16000);
        assert_eq!(
            core.require_lease("other", &lease.token, lease.fence),
            Err(ControlError::LeaseExpired)
        );
        assert_eq!(
            core.require_lease("human", "wrong", lease.fence),
            Err(ControlError::LeaseExpired)
        );
        assert_eq!(
            core.require_lease("human", &lease.token, lease.fence + 1),
            Err(ControlError::LeaseExpired)
        );
        core.revoked.fetch_add(1, Ordering::SeqCst);
        assert!(core.status().lease.is_none());
        assert_eq!(core.expire().unwrap().principal, "human");
        assert!(core.fence > lease.fence);
        assert_eq!(
            core.require_lease("human", &lease.token, lease.fence),
            Err(ControlError::LeaseExpired)
        );
        core.issue("human", 1000, 2000);
        core.lease.as_mut().unwrap().deadline = Instant::now();
        assert!(core.expire().is_some());
        assert!(core.expire().is_none());
    }

    #[test]
    fn renewal_caps_lifetime_without_extending_or_consuming_frame() {
        let mut core = ControlLeaseCore::default();
        let lease = core.issue("human", 1000, 2000);
        assert_eq!(lease.expires_at, 2000);
        let proof = core.register_frame("human", 1000, 60000, 100, 80).unwrap();
        assert_eq!(proof.expires_at, 6000);
        let deadline = core
            .frame("human", &proof.frame_id, proof.fence)
            .unwrap()
            .deadline;
        let renewed = core
            .renew("human", &lease.token, lease.fence, 1500, 3000)
            .unwrap();
        assert_eq!(renewed.expires_at, 3000);
        assert_eq!(renewed.token, lease.token);
        assert_eq!(renewed.fence, lease.fence);
        assert_eq!(
            core.frame("human", &proof.frame_id, proof.fence)
                .unwrap()
                .deadline,
            deadline
        );
        core.issue("human", 4000, 3000);
        assert!(core.expire().is_some());
    }

    #[test]
    fn frames_are_principal_and_fence_bound_and_single_use_globally() {
        let mut core = ControlLeaseCore::default();
        let proof = core.register_frame("human", 1000, 60000, 100, 80).unwrap();
        let other = core.register_frame("other", 1000, 60000, 100, 80).unwrap();
        assert!(core.frame("other", &proof.frame_id, proof.fence).is_err());
        assert!(core
            .frame("human", &proof.frame_id, proof.fence + 1)
            .is_err());
        assert_eq!(
            core.take_frame("human", &proof.frame_id, proof.fence)
                .unwrap()
                .width,
            100
        );
        assert!(core
            .take_frame("human", &proof.frame_id, proof.fence)
            .is_err());
        assert!(core.frame("other", &other.frame_id, other.fence).is_err());
        let proof = core.register_frame("human", 1000, 60000, 100, 80).unwrap();
        core.invalidate();
        assert!(core.frame("human", &proof.frame_id, proof.fence).is_err());
    }

    #[test]
    fn a_raised_frame_cap_admits_several_viewers_of_one_principal() {
        let mut core = ControlLeaseCore::with_frame_limit(16);
        for _ in 0..16 {
            core.register_frame("local-owner", 1000, 60000, 1, 1)
                .unwrap();
        }
        assert_eq!(
            core.register_frame("local-owner", 1000, 60000, 1, 1)
                .unwrap_err(),
            ControlError::FrameLimit
        );
        let mut floor = ControlLeaseCore::with_frame_limit(0);
        floor.register_frame("p", 1000, 60000, 1, 1).unwrap();
        assert_eq!(
            floor.register_frame("p", 1000, 60000, 1, 1).unwrap_err(),
            ControlError::FrameLimit
        );
        assert_eq!(
            ControlLeaseCore::default().frames_per_principal,
            FRAMES_PER_PRINCIPAL
        );
    }

    #[test]
    fn frame_limits_preserve_existing_proofs_and_expired_slots_are_reused() {
        let mut core = ControlLeaseCore::default();
        for n in 0..32 {
            core.register_frame(&n.to_string(), 1000, 60000, 1, 1)
                .unwrap();
        }
        assert!(matches!(
            core.register_frame("excess", 1000, 60000, 1, 1),
            Err(ControlError::ObserverLimit)
        ));
        for _ in 1..8 {
            core.register_frame("0", 1000, 60000, 1, 1).unwrap();
        }
        let oldest = core.frames["0"][0].id.clone();
        assert!(matches!(
            core.register_frame("0", 1000, 60000, 1, 1),
            Err(ControlError::FrameLimit)
        ));
        assert!(core.frame("0", &oldest, core.fence).is_ok());
        for frame in core.frames.get_mut("0").unwrap() {
            frame.deadline = Instant::now();
        }
        assert!(core.frame("0", &oldest, core.fence).is_err());
        core.register_frame("excess", 1000, 60000, 1, 1).unwrap();
        assert_eq!(core.frames.len(), 32);
        assert!(!core.frames.contains_key("0"));
    }
}
