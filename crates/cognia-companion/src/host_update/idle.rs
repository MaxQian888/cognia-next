//! Whether the host is idle enough to restart into an update.
//!
//! A host updates only when nothing would be cut off: no run in its brain, no
//! background job, no remote worker turn, no request mid-write, and no admin
//! lease (someone is in the middle of administering it). Each count comes from
//! the component that owns it; there is no single "busy" flag to trust.

use std::sync::Arc;

use serde::Serialize;

use crate::ws_bridge;

/// What keeps the host from updating, by source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleReport {
    /// Runs the brain reports executing; `None` when a connected brain has
    /// not reported recently, which counts as busy.
    pub active_runs: Option<u32>,
    pub jobs: u32,
    pub worker_slots: u32,
    pub mutations: u32,
    pub admin_leases: u32,
}

impl IdleReport {
    pub fn is_idle(&self) -> bool {
        self.active_runs == Some(0)
            && self.jobs == 0
            && self.worker_slots == 0
            && self.mutations == 0
            && self.admin_leases == 0
    }
}

pub trait IdleProbe: Send + Sync {
    fn report(&self, now_ms: i64) -> IdleReport;
}

/// The brain's run count, as the idle check reads it: zero when no brain is
/// connected (nothing can be running in it; a host whose brain is refused or
/// parked is exactly one that needs the update), the last report when it is
/// fresh, unknown when a connected brain has gone quiet.
pub fn brain_runs(
    connected: bool,
    activity: Option<ws_bridge::BrainActivity>,
    now_ms: i64,
) -> Option<u32> {
    if !connected {
        return Some(0);
    }
    let fresh_within = 3 * ws_bridge::BRAIN_HEARTBEAT.as_millis() as i64;
    activity
        .filter(|report| now_ms - report.reported_at_ms <= fresh_within)
        .map(|report| report.active_runs)
}

/// The live counts of this process.
pub struct LiveIdleProbe {
    /// Background jobs running, from the job supervisor the app owns.
    jobs: Arc<dyn Fn() -> u32 + Send + Sync>,
}

impl LiveIdleProbe {
    pub fn new(jobs: Arc<dyn Fn() -> u32 + Send + Sync>) -> Self {
        Self { jobs }
    }
}

impl IdleProbe for LiveIdleProbe {
    fn report(&self, now_ms: i64) -> IdleReport {
        IdleReport {
            active_runs: brain_runs(
                ws_bridge::bridge_ready(),
                ws_bridge::brain_activity(),
                now_ms,
            ),
            jobs: (self.jobs)(),
            worker_slots: crate::ws_worker::busy_worker_slots(),
            mutations: u32::try_from(crate::server::active_mutations()).unwrap_or(u32::MAX),
            admin_leases: u32::try_from(cognia_companion_security::admin_lease::live_count())
                .unwrap_or(u32::MAX),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(runs: u32, at: i64) -> Option<ws_bridge::BrainActivity> {
        Some(ws_bridge::BrainActivity {
            active_runs: runs,
            reported_at_ms: at,
        })
    }

    #[test]
    fn a_host_is_idle_only_when_every_source_is_quiet() {
        let quiet = IdleReport {
            active_runs: Some(0),
            ..IdleReport::default()
        };
        assert!(quiet.is_idle());
        for busy in [
            IdleReport {
                active_runs: Some(1),
                ..quiet.clone()
            },
            IdleReport {
                active_runs: None,
                ..quiet.clone()
            },
            IdleReport {
                jobs: 1,
                ..quiet.clone()
            },
            IdleReport {
                worker_slots: 1,
                ..quiet.clone()
            },
            IdleReport {
                mutations: 1,
                ..quiet.clone()
            },
            IdleReport {
                admin_leases: 1,
                ..quiet.clone()
            },
        ] {
            assert!(!busy.is_idle(), "{busy:?}");
        }
    }

    #[test]
    fn a_missing_brain_runs_nothing_and_a_quiet_one_is_unknown() {
        let heartbeat = ws_bridge::BRAIN_HEARTBEAT.as_millis() as i64;
        assert_eq!(brain_runs(false, None, 10_000), Some(0));
        assert_eq!(
            brain_runs(true, activity(2, 10_000), 10_000 + heartbeat),
            Some(2)
        );
        assert_eq!(brain_runs(true, activity(0, 0), 4 * heartbeat), None);
        assert_eq!(brain_runs(true, None, 0), None);
    }
}
