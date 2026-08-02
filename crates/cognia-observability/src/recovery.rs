//! `RecoveryStateV1` — the diagnostics-first safe-mode state machine (ADR-0102 §4).
//!
//! Ownership of these transitions lives here, in the native runtime, and not in
//! the renderer. That is deliberate and it is the fix for the defect this
//! module replaces: the previous TypeScript policy was pure, tested, and called
//! by nothing, so the capability matrix advertised a recovery path that could
//! never fire. Transitions now run in the process that survives a renderer
//! crash, persist through a kill, and are exposed to the UI over typed IPC.
//!
//! Three budgets bound the system so a failing subsystem cannot spin:
//!
//! - **Starts** — a second unhealthy start for the *same build* inside ten
//!   minutes enters safe mode. A different build starts a fresh window.
//! - **Renderer** — one automatic reload per five minutes; the next failure
//!   opens the safe shell and stops automatic reloads until health returns.
//! - **Children** — three restarts per subsystem at 1s/2s/4s; the fourth
//!   failure disables that subsystem and enters safe mode.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Ten minutes, in milliseconds. Both the unhealthy-start window and the
/// healthy-reset dwell time.
pub const HEALTH_WINDOW_MS: i64 = 10 * 60_000;
/// Five minutes, in milliseconds. The automatic renderer-reload budget.
pub const RENDERER_RELOAD_WINDOW_MS: i64 = 5 * 60_000;
/// Automatic restarts allowed per supervised child before the subsystem is
/// disabled.
pub const MAX_CHILD_RESTARTS: u32 = 3;
/// Bounded audit history. Old entries roll off; the counter resets do not
/// erase them.
pub const MAX_AUDIT_ENTRIES: usize = 100;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryMode {
    #[default]
    Normal,
    Safe,
    Recovering,
}

impl RecoveryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Safe => "safe",
            Self::Recovering => "recovering",
        }
    }
}

/// The six subsystem groups, in the order they are re-enabled. The list is
/// closed: a seventh group would change the recovery contract and needs an ADR
/// amendment, not a new enum variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoverySubsystem {
    Database,
    Plugins,
    Sidecar,
    Connectors,
    Workflow,
    ExternalAgent,
}

/// The recovery order. Later groups depend on earlier ones, so a failure stops
/// the sequence rather than enabling a group whose dependency is broken.
pub const RECOVERY_ORDER: [RecoverySubsystem; 6] = [
    RecoverySubsystem::Database,
    RecoverySubsystem::Plugins,
    RecoverySubsystem::Sidecar,
    RecoverySubsystem::Connectors,
    RecoverySubsystem::Workflow,
    RecoverySubsystem::ExternalAgent,
];

impl RecoverySubsystem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Plugins => "plugins",
            Self::Sidecar => "sidecar",
            Self::Connectors => "connectors",
            Self::Workflow => "workflow",
            Self::ExternalAgent => "external-agent",
        }
    }

    /// Position in `RECOVERY_ORDER`.
    pub fn order(self) -> usize {
        RECOVERY_ORDER
            .iter()
            .position(|candidate| *candidate == self)
            .unwrap_or(usize::MAX)
    }
}

impl std::fmt::Display for RecoverySubsystem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointStatus {
    /// Not attempted yet in this session.
    #[default]
    Pending,
    Passed,
    Failed,
    /// An earlier group failed, so this one was never attempted. Distinct from
    /// `Pending` because it tells the operator *why* nothing happened.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    pub subsystem: RecoverySubsystem,
    pub status: CheckpointStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// Epoch milliseconds. `None` while pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAuditEntry {
    /// Epoch milliseconds.
    pub at: i64,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsystem: Option<RecoverySubsystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererReloadBudget {
    /// Epoch milliseconds of the last automatic reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reload_at: Option<i64>,
    /// Set once the budget is spent. Cleared only by a healthy reset — not by
    /// the passage of time — so a flapping renderer cannot reload forever.
    #[serde(default)]
    pub automatic_reloads_disabled: bool,
}

fn schema_version_one() -> u8 {
    1
}

/// Persisted recovery state. Timestamps are epoch milliseconds throughout, so
/// the renderer can render them without a parse step and a clock injected by a
/// test behaves like the real one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStateV1 {
    #[serde(default = "schema_version_one")]
    pub schema_version: u8,
    /// CI-injected build identifier, shared with `scope.buildId` on every
    /// event, so an incident and the recovery state agree on which build broke.
    pub build_id: String,
    pub mode: RecoveryMode,
    /// Epoch milliseconds of unhealthy starts inside the current window.
    #[serde(default)]
    pub unhealthy_starts: Vec<i64>,
    #[serde(default)]
    pub checkpoints: Vec<CheckpointResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspect_subsystem: Option<RecoverySubsystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspect_reason_code: Option<String>,
    /// Epoch milliseconds since which everything has been healthy. `None` until
    /// a renderer heartbeat *and* every enabled checkpoint have landed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_since: Option<i64>,
    #[serde(default)]
    pub renderer_reload: RendererReloadBudget,
    #[serde(default)]
    pub child_restarts: BTreeMap<RecoverySubsystem, u32>,
    /// Subsystems held off after exhausting their restart budget, or turned off
    /// by an explicit operator decision.
    #[serde(default)]
    pub disabled_subsystems: BTreeSet<RecoverySubsystem>,
    /// Whether the renderer has reported alive in this session. The healthy
    /// timer does not start without it — a process whose UI never came up is
    /// not healthy just because no subsystem complained.
    #[serde(default)]
    pub renderer_alive: bool,
    #[serde(default)]
    pub audit: Vec<RecoveryAuditEntry>,
}

/// What the supervisor should do about a renderer failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RendererAction {
    Reload,
    /// One-shot diagnostics shell. Automatic reloads stop here.
    OpenSafeShell,
}

/// What the supervisor should do about a supervised child exiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChildAction {
    Restart { delay_ms: u64, attempt: u32 },
    Disable { subsystem: RecoverySubsystem },
}

impl RecoveryStateV1 {
    pub fn new(build_id: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            build_id: build_id.into(),
            mode: RecoveryMode::Normal,
            unhealthy_starts: Vec::new(),
            checkpoints: RECOVERY_ORDER
                .iter()
                .map(|subsystem| CheckpointResult {
                    subsystem: *subsystem,
                    status: CheckpointStatus::Pending,
                    reason_code: None,
                    at: None,
                })
                .collect(),
            suspect_subsystem: None,
            suspect_reason_code: None,
            stable_since: None,
            renderer_reload: RendererReloadBudget::default(),
            child_restarts: BTreeMap::new(),
            disabled_subsystems: BTreeSet::new(),
            renderer_alive: false,
            audit: Vec::new(),
        }
    }

    fn push_audit(&mut self, entry: RecoveryAuditEntry) {
        self.audit.push(entry);
        if self.audit.len() > MAX_AUDIT_ENTRIES {
            let overflow = self.audit.len() - MAX_AUDIT_ENTRIES;
            self.audit.drain(0..overflow);
        }
    }

    fn audit_at(&mut self, at: i64, code: &str) {
        self.push_audit(RecoveryAuditEntry {
            at,
            code: code.to_string(),
            subsystem: None,
            success: None,
            reason_code: None,
        });
    }

    /// Adopt a build id, resetting the failure window when it changed. A new
    /// build has not failed yet, so it must not inherit the old one's budget.
    pub fn adopt_build(&mut self, build_id: &str, at: i64) {
        if self.build_id == build_id {
            return;
        }
        let previous = std::mem::replace(&mut self.build_id, build_id.to_string());
        self.unhealthy_starts.clear();
        self.child_restarts.clear();
        self.disabled_subsystems.clear();
        self.renderer_reload = RendererReloadBudget::default();
        self.suspect_subsystem = None;
        self.suspect_reason_code = None;
        self.stable_since = None;
        self.renderer_alive = false;
        self.mode = RecoveryMode::Normal;
        self.reset_checkpoints();
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.build.changed".into(),
            subsystem: None,
            success: None,
            reason_code: Some(previous),
        });
    }

    fn reset_checkpoints(&mut self) {
        self.checkpoints = RECOVERY_ORDER
            .iter()
            .map(|subsystem| CheckpointResult {
                subsystem: *subsystem,
                status: CheckpointStatus::Pending,
                reason_code: None,
                at: None,
            })
            .collect();
    }

    /// A cold start where the previous release session ended abnormally.
    ///
    /// The second such start for the same build inside ten minutes enters safe
    /// mode. One failure does not, and neither do two failures spread wider
    /// than the window — a machine that crashes once a day is not a machine
    /// that should boot into diagnostics.
    pub fn record_unhealthy_start(&mut self, at: i64) -> RecoveryMode {
        self.unhealthy_starts
            .retain(|started| at - started <= HEALTH_WINDOW_MS && *started <= at);
        self.unhealthy_starts.push(at);
        self.stable_since = None;
        self.renderer_alive = false;
        self.reset_checkpoints();

        if self.unhealthy_starts.len() >= 2 {
            self.mode = RecoveryMode::Safe;
            self.push_audit(RecoveryAuditEntry {
                at,
                code: "recovery.start.unhealthy".into(),
                subsystem: None,
                success: Some(false),
                reason_code: Some("start.second_failure_in_window".into()),
            });
        } else {
            self.push_audit(RecoveryAuditEntry {
                at,
                code: "recovery.start.unhealthy".into(),
                subsystem: None,
                success: Some(false),
                reason_code: Some("start.first_failure".into()),
            });
        }
        self.mode
    }

    /// A cold start where the previous session exited cleanly.
    pub fn record_clean_start(&mut self, at: i64) {
        self.renderer_alive = false;
        self.stable_since = None;
        self.reset_checkpoints();
        // Safe mode persists across a clean start on purpose: the operator has
        // not yet told us the problem is fixed, and silently returning to a
        // full boot would re-run whatever broke.
        self.audit_at(at, "recovery.start.clean");
    }

    /// The renderer reported alive. Required before the healthy timer can run.
    pub fn record_renderer_heartbeat(&mut self, at: i64) {
        self.renderer_alive = true;
        self.maybe_start_stable_timer(at);
    }

    /// The renderer failed (crash, hang, or watchdog timeout).
    pub fn record_renderer_failure(&mut self, at: i64) -> RendererAction {
        self.renderer_alive = false;
        self.stable_since = None;

        let within_budget = self
            .renderer_reload
            .last_reload_at
            .map(|last| at - last >= RENDERER_RELOAD_WINDOW_MS)
            .unwrap_or(true);

        if within_budget && !self.renderer_reload.automatic_reloads_disabled {
            self.renderer_reload.last_reload_at = Some(at);
            self.audit_at(at, "recovery.renderer.reload");
            return RendererAction::Reload;
        }

        self.renderer_reload.automatic_reloads_disabled = true;
        self.mode = RecoveryMode::Safe;
        self.suspect_subsystem = None;
        self.suspect_reason_code = Some("renderer.reload_budget_exhausted".into());
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.renderer.safe_shell".into(),
            subsystem: None,
            success: Some(false),
            reason_code: Some("renderer.reload_budget_exhausted".into()),
        });
        RendererAction::OpenSafeShell
    }

    /// A supervised child for `subsystem` exited unexpectedly.
    pub fn record_child_failure(&mut self, subsystem: RecoverySubsystem, at: i64) -> ChildAction {
        self.stable_since = None;
        let attempt = self.child_restarts.entry(subsystem).or_insert(0);
        *attempt += 1;
        let attempt = *attempt;

        if attempt <= MAX_CHILD_RESTARTS {
            let delay_ms = 1_000u64 << (attempt - 1);
            self.push_audit(RecoveryAuditEntry {
                at,
                code: "recovery.child.restart".into(),
                subsystem: Some(subsystem),
                success: None,
                reason_code: Some(format!("child.attempt_{attempt}")),
            });
            return ChildAction::Restart { delay_ms, attempt };
        }

        self.disabled_subsystems.insert(subsystem);
        self.mode = RecoveryMode::Safe;
        self.suspect_subsystem = Some(subsystem);
        self.suspect_reason_code = Some("child.restart_budget_exhausted".into());
        self.mark_checkpoint(
            subsystem,
            CheckpointStatus::Failed,
            Some("child.restart_budget_exhausted".into()),
            at,
        );
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.child.disabled".into(),
            subsystem: Some(subsystem),
            success: Some(false),
            reason_code: Some("child.restart_budget_exhausted".into()),
        });
        ChildAction::Disable { subsystem }
    }

    fn mark_checkpoint(
        &mut self,
        subsystem: RecoverySubsystem,
        status: CheckpointStatus,
        reason_code: Option<String>,
        at: i64,
    ) {
        if let Some(slot) = self
            .checkpoints
            .iter_mut()
            .find(|slot| slot.subsystem == subsystem)
        {
            slot.status = status;
            slot.reason_code = reason_code;
            slot.at = Some(at);
        }
    }

    /// Record the outcome of one subsystem's read-only health probe.
    ///
    /// A failure stops the sequence: every later group is marked `Skipped` and
    /// the suspect is recorded. Groups that already passed stay available —
    /// containment, not a full rollback.
    pub fn record_checkpoint(
        &mut self,
        subsystem: RecoverySubsystem,
        success: bool,
        reason_code: Option<String>,
        at: i64,
    ) -> RecoveryMode {
        if success {
            self.mark_checkpoint(subsystem, CheckpointStatus::Passed, None, at);
            if self.suspect_subsystem == Some(subsystem) {
                self.suspect_subsystem = None;
                self.suspect_reason_code = None;
            }
            if self.mode == RecoveryMode::Safe {
                self.mode = RecoveryMode::Recovering;
            }
            self.push_audit(RecoveryAuditEntry {
                at,
                code: "recovery.checkpoint.passed".into(),
                subsystem: Some(subsystem),
                success: Some(true),
                reason_code: None,
            });
            self.maybe_start_stable_timer(at);
            return self.mode;
        }

        self.mark_checkpoint(subsystem, CheckpointStatus::Failed, reason_code.clone(), at);
        let failed_order = subsystem.order();
        for slot in self.checkpoints.iter_mut() {
            if slot.subsystem.order() > failed_order && slot.status == CheckpointStatus::Pending {
                slot.status = CheckpointStatus::Skipped;
                slot.reason_code = Some(format!("blocked_by.{subsystem}"));
                slot.at = Some(at);
            }
        }
        self.mode = RecoveryMode::Safe;
        self.stable_since = None;
        self.suspect_subsystem = Some(subsystem);
        self.suspect_reason_code = reason_code.clone();
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.checkpoint.failed".into(),
            subsystem: Some(subsystem),
            success: Some(false),
            reason_code,
        });
        self.mode
    }

    /// An operator asked to retry `subsystem`. Audited, and it clears the
    /// skipped markers so the sequence can run again from that point.
    pub fn record_retry(&mut self, subsystem: RecoverySubsystem, at: i64) {
        self.disabled_subsystems.remove(&subsystem);
        self.child_restarts.remove(&subsystem);
        let from = subsystem.order();
        for slot in self.checkpoints.iter_mut() {
            if slot.subsystem.order() >= from {
                slot.status = CheckpointStatus::Pending;
                slot.reason_code = None;
                slot.at = None;
            }
        }
        if self.suspect_subsystem == Some(subsystem) {
            self.suspect_subsystem = None;
            self.suspect_reason_code = None;
        }
        self.stable_since = None;
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.subsystem.retry".into(),
            subsystem: Some(subsystem),
            success: None,
            reason_code: None,
        });
    }

    /// An operator chose to keep `subsystem` disabled. Audited, and the
    /// remaining groups are allowed to proceed without it.
    pub fn record_keep_disabled(&mut self, subsystem: RecoverySubsystem, at: i64) {
        self.disabled_subsystems.insert(subsystem);
        self.mark_checkpoint(
            subsystem,
            CheckpointStatus::Skipped,
            Some("operator.kept_disabled".into()),
            at,
        );
        let from = subsystem.order();
        for slot in self.checkpoints.iter_mut() {
            if slot.subsystem.order() > from && slot.status == CheckpointStatus::Skipped {
                slot.status = CheckpointStatus::Pending;
                slot.reason_code = None;
                slot.at = None;
            }
        }
        if self.suspect_subsystem == Some(subsystem) {
            self.suspect_subsystem = None;
        }
        self.push_audit(RecoveryAuditEntry {
            at,
            code: "recovery.subsystem.kept_disabled".into(),
            subsystem: Some(subsystem),
            success: None,
            reason_code: Some("operator.kept_disabled".into()),
        });
    }

    /// Whether every subsystem that is *enabled* has passed its checkpoint.
    /// Disabled groups do not block health — the operator already accepted
    /// running without them.
    pub fn all_enabled_checkpoints_passed(&self) -> bool {
        self.checkpoints.iter().all(|slot| {
            self.disabled_subsystems.contains(&slot.subsystem)
                || slot.status == CheckpointStatus::Passed
        })
    }

    fn maybe_start_stable_timer(&mut self, at: i64) {
        if self.stable_since.is_some() {
            return;
        }
        if self.renderer_alive && self.all_enabled_checkpoints_passed() {
            self.stable_since = Some(at);
        }
    }

    /// Advance the healthy timer. Ten uninterrupted minutes clears the
    /// unhealthy-start, renderer-reload and child-restart counters and returns
    /// to normal. The audit history is kept — the counters are a budget, the
    /// audit is the record.
    pub fn record_healthy_tick(&mut self, at: i64) -> RecoveryMode {
        if !self.renderer_alive || !self.all_enabled_checkpoints_passed() {
            self.stable_since = None;
            return self.mode;
        }
        let stable_since = *self.stable_since.get_or_insert(at);
        if at - stable_since < HEALTH_WINDOW_MS {
            return self.mode;
        }

        self.mode = RecoveryMode::Normal;
        self.unhealthy_starts.clear();
        self.child_restarts.clear();
        self.renderer_reload = RendererReloadBudget::default();
        self.suspect_subsystem = None;
        self.suspect_reason_code = None;
        self.stable_since = None;
        self.audit_at(at, "recovery.stable");
        self.mode
    }

    /// True when the app must boot into the diagnostics shell.
    pub fn requires_safe_shell(&self) -> bool {
        self.mode == RecoveryMode::Safe
    }

    /// The next subsystem whose probe should run, or `None` when the sequence
    /// is finished or blocked.
    pub fn next_checkpoint(&self) -> Option<RecoverySubsystem> {
        for slot in &self.checkpoints {
            if self.disabled_subsystems.contains(&slot.subsystem) {
                continue;
            }
            match slot.status {
                CheckpointStatus::Pending => return Some(slot.subsystem),
                CheckpointStatus::Failed | CheckpointStatus::Skipped => return None,
                CheckpointStatus::Passed => continue,
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_785_000_000_000;
    const MINUTE: i64 = 60_000;

    fn state() -> RecoveryStateV1 {
        RecoveryStateV1::new("build-1")
    }

    fn pass_all(state: &mut RecoveryStateV1, at: i64) {
        for subsystem in RECOVERY_ORDER {
            state.record_checkpoint(subsystem, true, None, at);
        }
    }

    // --- start budget ------------------------------------------------------

    #[test]
    fn one_unhealthy_start_does_not_enter_safe_mode() {
        let mut state = state();
        assert_eq!(state.record_unhealthy_start(T0), RecoveryMode::Normal);
        assert!(!state.requires_safe_shell());
    }

    #[test]
    fn a_second_unhealthy_start_inside_the_window_enters_safe_mode() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        assert_eq!(
            state.record_unhealthy_start(T0 + 5 * MINUTE),
            RecoveryMode::Safe
        );
        assert!(state.requires_safe_shell());
    }

    #[test]
    fn two_unhealthy_starts_outside_the_window_do_not_enter_safe_mode() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        assert_eq!(
            state.record_unhealthy_start(T0 + 11 * MINUTE),
            RecoveryMode::Normal,
            "a crash every eleven minutes is not a boot loop"
        );
        assert_eq!(state.unhealthy_starts.len(), 1);
    }

    #[test]
    fn a_different_build_starts_a_fresh_failure_window() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + MINUTE);
        assert_eq!(state.mode, RecoveryMode::Safe);

        state.adopt_build("build-2", T0 + 2 * MINUTE);
        assert_eq!(state.mode, RecoveryMode::Normal);
        assert!(state.unhealthy_starts.is_empty());
        assert_eq!(state.build_id, "build-2");
        assert!(state
            .audit
            .iter()
            .any(|entry| entry.code == "recovery.build.changed"));

        // And the fresh window needs two failures of its own.
        assert_eq!(
            state.record_unhealthy_start(T0 + 3 * MINUTE),
            RecoveryMode::Normal
        );
    }

    #[test]
    fn adopting_the_same_build_changes_nothing() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        let before = state.clone();
        state.adopt_build("build-1", T0 + MINUTE);
        assert_eq!(state, before);
    }

    #[test]
    fn a_clean_start_does_not_leave_safe_mode_on_its_own() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + MINUTE);
        state.record_clean_start(T0 + 2 * MINUTE);
        assert_eq!(
            state.mode,
            RecoveryMode::Safe,
            "a clean boot into the safe shell is not evidence the app is fixed"
        );
    }

    // --- renderer budget ---------------------------------------------------

    #[test]
    fn the_first_renderer_failure_reloads() {
        let mut state = state();
        assert_eq!(state.record_renderer_failure(T0), RendererAction::Reload);
        assert_eq!(state.renderer_reload.last_reload_at, Some(T0));
        assert!(!state.renderer_reload.automatic_reloads_disabled);
    }

    #[test]
    fn a_second_renderer_failure_inside_five_minutes_opens_the_safe_shell() {
        let mut state = state();
        state.record_renderer_failure(T0);
        assert_eq!(
            state.record_renderer_failure(T0 + 2 * MINUTE),
            RendererAction::OpenSafeShell
        );
        assert!(state.renderer_reload.automatic_reloads_disabled);
        assert_eq!(state.mode, RecoveryMode::Safe);
        assert_eq!(
            state.suspect_reason_code.as_deref(),
            Some("renderer.reload_budget_exhausted")
        );
    }

    #[test]
    fn a_renderer_failure_after_the_window_reloads_again() {
        let mut state = state();
        state.record_renderer_failure(T0);
        assert_eq!(
            state.record_renderer_failure(T0 + 6 * MINUTE),
            RendererAction::Reload
        );
    }

    #[test]
    fn automatic_reloads_stay_off_until_health_returns_even_after_the_window() {
        let mut state = state();
        state.record_renderer_failure(T0);
        state.record_renderer_failure(T0 + MINUTE);
        assert!(state.renderer_reload.automatic_reloads_disabled);
        // Waiting past the five-minute window is NOT enough — only a healthy
        // reset re-arms automatic reloads.
        assert_eq!(
            state.record_renderer_failure(T0 + 10 * MINUTE),
            RendererAction::OpenSafeShell
        );
    }

    // --- child budget ------------------------------------------------------

    #[test]
    fn children_restart_three_times_with_exponential_backoff() {
        let mut state = state();
        let delays: Vec<u64> = (0..3)
            .map(
                |index| match state.record_child_failure(RecoverySubsystem::Sidecar, T0 + index) {
                    ChildAction::Restart { delay_ms, attempt } => {
                        assert_eq!(attempt as i64, index + 1);
                        delay_ms
                    }
                    other => panic!("expected restart, got {other:?}"),
                },
            )
            .collect();
        assert_eq!(delays, vec![1_000, 2_000, 4_000]);
    }

    #[test]
    fn the_fourth_child_failure_disables_the_subsystem_and_enters_safe_mode() {
        let mut state = state();
        for index in 0..3 {
            state.record_child_failure(RecoverySubsystem::Sidecar, T0 + index);
        }
        let action = state.record_child_failure(RecoverySubsystem::Sidecar, T0 + 4);
        assert_eq!(
            action,
            ChildAction::Disable {
                subsystem: RecoverySubsystem::Sidecar
            }
        );
        assert_eq!(state.mode, RecoveryMode::Safe);
        assert!(state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Sidecar));
        assert_eq!(state.suspect_subsystem, Some(RecoverySubsystem::Sidecar));
    }

    #[test]
    fn child_budgets_are_tracked_per_subsystem() {
        let mut state = state();
        for index in 0..3 {
            state.record_child_failure(RecoverySubsystem::Sidecar, T0 + index);
        }
        // A different subsystem still has its full budget.
        assert!(matches!(
            state.record_child_failure(RecoverySubsystem::Workflow, T0 + 4),
            ChildAction::Restart { attempt: 1, .. }
        ));
        assert_eq!(state.mode, RecoveryMode::Normal);
    }

    // --- checkpoint sequencing ---------------------------------------------

    #[test]
    fn checkpoints_start_pending_in_the_documented_order() {
        let state = state();
        let order: Vec<RecoverySubsystem> = state
            .checkpoints
            .iter()
            .map(|slot| slot.subsystem)
            .collect();
        assert_eq!(order, RECOVERY_ORDER.to_vec());
        assert!(state
            .checkpoints
            .iter()
            .all(|slot| slot.status == CheckpointStatus::Pending));
        assert_eq!(state.next_checkpoint(), Some(RecoverySubsystem::Database));
    }

    #[test]
    fn a_failure_skips_every_later_group_and_names_the_blocker() {
        let mut state = state();
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0);
        state.record_checkpoint(
            RecoverySubsystem::Plugins,
            false,
            Some("plugins.manifest_invalid".into()),
            T0 + 1,
        );

        let by_subsystem = |subsystem: RecoverySubsystem| {
            state
                .checkpoints
                .iter()
                .find(|slot| slot.subsystem == subsystem)
                .cloned()
                .expect("slot")
        };
        assert_eq!(
            by_subsystem(RecoverySubsystem::Database).status,
            CheckpointStatus::Passed,
            "an already-passed group stays available"
        );
        assert_eq!(
            by_subsystem(RecoverySubsystem::Plugins).status,
            CheckpointStatus::Failed
        );
        for later in [
            RecoverySubsystem::Sidecar,
            RecoverySubsystem::Connectors,
            RecoverySubsystem::Workflow,
            RecoverySubsystem::ExternalAgent,
        ] {
            let slot = by_subsystem(later);
            assert_eq!(slot.status, CheckpointStatus::Skipped);
            assert_eq!(slot.reason_code.as_deref(), Some("blocked_by.plugins"));
        }
        assert_eq!(state.suspect_subsystem, Some(RecoverySubsystem::Plugins));
        assert_eq!(
            state.suspect_reason_code.as_deref(),
            Some("plugins.manifest_invalid")
        );
        assert_eq!(state.next_checkpoint(), None);
    }

    #[test]
    fn passing_a_checkpoint_from_safe_mode_moves_to_recovering() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + MINUTE);
        assert_eq!(state.mode, RecoveryMode::Safe);
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0 + 2 * MINUTE);
        assert_eq!(state.mode, RecoveryMode::Recovering);
    }

    #[test]
    fn retry_reopens_the_failed_group_and_everything_after_it() {
        let mut state = state();
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0);
        state.record_checkpoint(
            RecoverySubsystem::Plugins,
            false,
            Some("boom".into()),
            T0 + 1,
        );
        state.record_retry(RecoverySubsystem::Plugins, T0 + 2);

        assert_eq!(state.next_checkpoint(), Some(RecoverySubsystem::Plugins));
        assert_eq!(state.suspect_subsystem, None);
        assert!(state
            .audit
            .iter()
            .any(|entry| entry.code == "recovery.subsystem.retry"
                && entry.subsystem == Some(RecoverySubsystem::Plugins)));
    }

    #[test]
    fn retry_clears_a_child_restart_budget_and_re_enables_the_subsystem() {
        let mut state = state();
        for index in 0..4 {
            state.record_child_failure(RecoverySubsystem::Sidecar, T0 + index);
        }
        assert!(state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Sidecar));
        state.record_retry(RecoverySubsystem::Sidecar, T0 + 10);
        assert!(!state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Sidecar));
        assert!(matches!(
            state.record_child_failure(RecoverySubsystem::Sidecar, T0 + 11),
            ChildAction::Restart { attempt: 1, .. }
        ));
    }

    #[test]
    fn keeping_a_subsystem_disabled_lets_the_rest_proceed() {
        let mut state = state();
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0);
        state.record_checkpoint(
            RecoverySubsystem::Plugins,
            false,
            Some("boom".into()),
            T0 + 1,
        );
        state.record_keep_disabled(RecoverySubsystem::Plugins, T0 + 2);

        assert!(state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Plugins));
        assert_eq!(state.next_checkpoint(), Some(RecoverySubsystem::Sidecar));
        assert!(state
            .audit
            .iter()
            .any(|entry| entry.code == "recovery.subsystem.kept_disabled"));
    }

    #[test]
    fn a_disabled_subsystem_does_not_block_health() {
        let mut state = state();
        state.record_renderer_heartbeat(T0);
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0);
        state.record_checkpoint(
            RecoverySubsystem::Plugins,
            false,
            Some("boom".into()),
            T0 + 1,
        );
        state.record_keep_disabled(RecoverySubsystem::Plugins, T0 + 2);
        for subsystem in [
            RecoverySubsystem::Sidecar,
            RecoverySubsystem::Connectors,
            RecoverySubsystem::Workflow,
            RecoverySubsystem::ExternalAgent,
        ] {
            state.record_checkpoint(subsystem, true, None, T0 + 3);
        }
        assert!(state.all_enabled_checkpoints_passed());
    }

    // --- healthy reset -----------------------------------------------------

    #[test]
    fn the_healthy_timer_does_not_start_without_a_renderer_heartbeat() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + MINUTE);
        assert_eq!(state.mode, RecoveryMode::Safe);

        // Every probe passes, but the UI never reported alive.
        pass_all(&mut state, T0 + 2 * MINUTE);
        assert_eq!(state.stable_since, None);

        assert_eq!(
            state.record_healthy_tick(T0 + 20 * MINUTE),
            RecoveryMode::Recovering,
            "a headless process that passes its probes has not recovered"
        );
        assert_eq!(state.stable_since, None);
        assert!(!state.unhealthy_starts.is_empty());
    }

    #[test]
    fn the_healthy_timer_does_not_start_until_every_checkpoint_passes() {
        let mut state = state();
        state.record_renderer_heartbeat(T0);
        state.record_checkpoint(RecoverySubsystem::Database, true, None, T0);
        assert_eq!(state.stable_since, None);
        pass_all(&mut state, T0 + 1);
        assert_eq!(state.stable_since, Some(T0 + 1));
    }

    #[test]
    fn ten_uninterrupted_minutes_clear_every_counter_but_keep_the_audit() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_child_failure(RecoverySubsystem::Sidecar, T0);
        state.record_renderer_failure(T0);
        state.record_renderer_heartbeat(T0 + MINUTE);
        pass_all(&mut state, T0 + MINUTE);
        assert_eq!(state.stable_since, Some(T0 + MINUTE));

        assert_eq!(
            state.record_healthy_tick(T0 + 5 * MINUTE),
            state.mode,
            "five minutes is not enough"
        );
        assert!(!state.unhealthy_starts.is_empty());

        state.record_healthy_tick(T0 + 12 * MINUTE);
        assert_eq!(state.mode, RecoveryMode::Normal);
        assert!(state.unhealthy_starts.is_empty());
        assert!(state.child_restarts.is_empty());
        assert_eq!(state.renderer_reload, RendererReloadBudget::default());
        assert!(
            state
                .audit
                .iter()
                .any(|entry| entry.code == "recovery.stable"),
            "the audit records the reset"
        );
        assert!(
            state
                .audit
                .iter()
                .any(|entry| entry.code == "recovery.start.unhealthy"),
            "clearing the budget must not erase the history"
        );
    }

    #[test]
    fn a_checkpoint_failure_resets_the_healthy_timer() {
        let mut state = state();
        state.record_renderer_heartbeat(T0);
        pass_all(&mut state, T0);
        assert!(state.stable_since.is_some());
        state.record_checkpoint(
            RecoverySubsystem::Workflow,
            false,
            Some("boom".into()),
            T0 + MINUTE,
        );
        assert_eq!(state.stable_since, None);
    }

    #[test]
    fn a_renderer_timeout_resets_the_healthy_timer() {
        let mut state = state();
        state.record_renderer_heartbeat(T0);
        pass_all(&mut state, T0);
        state.record_renderer_failure(T0 + MINUTE);
        assert_eq!(state.stable_since, None);
        assert!(!state.renderer_alive);
    }

    #[test]
    fn a_child_exit_resets_the_healthy_timer() {
        let mut state = state();
        state.record_renderer_heartbeat(T0);
        pass_all(&mut state, T0);
        state.record_child_failure(RecoverySubsystem::Connectors, T0 + MINUTE);
        assert_eq!(state.stable_since, None);
    }

    #[test]
    fn a_healthy_reset_re_arms_automatic_renderer_reloads() {
        let mut state = state();
        state.record_renderer_failure(T0);
        state.record_renderer_failure(T0 + MINUTE);
        assert!(state.renderer_reload.automatic_reloads_disabled);

        state.record_renderer_heartbeat(T0 + 2 * MINUTE);
        pass_all(&mut state, T0 + 2 * MINUTE);
        state.record_healthy_tick(T0 + 13 * MINUTE);
        assert!(!state.renderer_reload.automatic_reloads_disabled);
        assert_eq!(
            state.record_renderer_failure(T0 + 14 * MINUTE),
            RendererAction::Reload
        );
    }

    // --- persistence shape -------------------------------------------------

    #[test]
    fn state_round_trips_through_json_with_camel_case_keys() {
        let mut state = state();
        state.record_unhealthy_start(T0);
        state.record_checkpoint(
            RecoverySubsystem::Database,
            false,
            Some("db.locked".into()),
            T0,
        );
        let json = serde_json::to_string(&state).expect("serializes");
        assert!(json.contains("\"buildId\""));
        assert!(json.contains("\"unhealthyStarts\""));
        assert!(json.contains("\"suspectSubsystem\""));
        assert!(json.contains("\"external-agent\""));
        let back: RecoveryStateV1 = serde_json::from_str(&json).expect("parses");
        assert_eq!(back, state);
    }

    #[test]
    fn a_state_written_by_an_older_build_still_loads() {
        // Only the required fields; everything else defaults.
        let raw = r#"{"buildId":"build-0","mode":"normal"}"#;
        let state: RecoveryStateV1 = serde_json::from_str(raw).expect("parses");
        assert_eq!(state.build_id, "build-0");
        assert_eq!(state.schema_version, 1);
        assert!(state.checkpoints.is_empty());
        assert!(!state.renderer_alive);
    }

    #[test]
    fn the_audit_history_is_bounded() {
        let mut state = state();
        for index in 0..(MAX_AUDIT_ENTRIES as i64 + 50) {
            state.record_renderer_heartbeat(T0 + index);
            state.audit_at(T0 + index, "recovery.test");
        }
        assert_eq!(state.audit.len(), MAX_AUDIT_ENTRIES);
        assert_eq!(state.audit.last().expect("entry").at, T0 + 149);
    }

    #[test]
    fn subsystem_order_matches_the_documented_sequence() {
        assert_eq!(RecoverySubsystem::Database.order(), 0);
        assert_eq!(RecoverySubsystem::ExternalAgent.order(), 5);
        let names: Vec<&str> = RECOVERY_ORDER.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "database",
                "plugins",
                "sidecar",
                "connectors",
                "workflow",
                "external-agent"
            ]
        );
    }

    // --- shared golden scenarios ------------------------------------------
    //
    // Each fixture is a scenario (`steps`) plus the state the machine must
    // reach (`expected`). Rust replays the steps; the TypeScript suite reads
    // `expected` through its selectors. Neither side can drift without the
    // other failing, which is the guarantee the old renderer-side policy could
    // not offer — it computed transitions nothing ever compared against.
    //
    // Regenerate with:
    //   UPDATE_OBSERVABILITY_FIXTURES=1 cargo test -p cognia-observability

    const SCENARIO_BASE_MS: i64 = 1_785_000_000_000;

    // `rename_all` renames the *variants*; `rename_all_fields` is what carries
    // camelCase into the variant bodies. Without the second attribute a
    // fixture's `reasonCode` deserializes as `None` and the golden state
    // quietly loses the reason a checkpoint failed.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
    enum ScenarioStep {
        UnhealthyStart {
            at: i64,
        },
        CleanStart {
            at: i64,
        },
        Heartbeat {
            at: i64,
        },
        RendererFailure {
            at: i64,
        },
        ChildFailure {
            subsystem: RecoverySubsystem,
            at: i64,
        },
        Checkpoint {
            subsystem: RecoverySubsystem,
            success: bool,
            #[serde(default)]
            reason_code: Option<String>,
            at: i64,
        },
        Retry {
            subsystem: RecoverySubsystem,
            at: i64,
        },
        KeepDisabled {
            subsystem: RecoverySubsystem,
            at: i64,
        },
        HealthyTick {
            at: i64,
        },
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Scenario {
        name: String,
        build_id: String,
        steps: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected: Option<RecoveryStateV1>,
    }

    fn replay(build_id: &str, steps: &[ScenarioStep]) -> RecoveryStateV1 {
        let mut state = RecoveryStateV1::new(build_id);
        for step in steps {
            match step {
                ScenarioStep::UnhealthyStart { at } => {
                    state.record_unhealthy_start(SCENARIO_BASE_MS + at);
                }
                ScenarioStep::CleanStart { at } => {
                    state.record_clean_start(SCENARIO_BASE_MS + at);
                }
                ScenarioStep::Heartbeat { at } => {
                    state.record_renderer_heartbeat(SCENARIO_BASE_MS + at);
                }
                ScenarioStep::RendererFailure { at } => {
                    state.record_renderer_failure(SCENARIO_BASE_MS + at);
                }
                ScenarioStep::ChildFailure { subsystem, at } => {
                    state.record_child_failure(*subsystem, SCENARIO_BASE_MS + at);
                }
                ScenarioStep::Checkpoint {
                    subsystem,
                    success,
                    reason_code,
                    at,
                } => {
                    state.record_checkpoint(
                        *subsystem,
                        *success,
                        reason_code.clone(),
                        SCENARIO_BASE_MS + at,
                    );
                }
                ScenarioStep::Retry { subsystem, at } => {
                    state.record_retry(*subsystem, SCENARIO_BASE_MS + at);
                }
                ScenarioStep::KeepDisabled { subsystem, at } => {
                    state.record_keep_disabled(*subsystem, SCENARIO_BASE_MS + at);
                }
                ScenarioStep::HealthyTick { at } => {
                    state.record_healthy_tick(SCENARIO_BASE_MS + at);
                }
            }
        }
        state
    }

    #[test]
    fn shared_recovery_scenarios_replay_to_their_golden_state() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/logging/src/schemas/recovery-fixtures");
        let update = std::env::var("UPDATE_OBSERVABILITY_FIXTURES").is_ok();

        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("recovery fixture dir exists")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                (path.extension()?.to_str()? == "json").then_some(path)
            })
            .collect();
        files.sort();
        assert!(!files.is_empty(), "recovery fixtures must exist");

        for path in files {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let raw = std::fs::read_to_string(&path).expect("fixture reads");
            let mut scenario: Scenario =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name}: {e}"));
            let steps: Vec<ScenarioStep> = serde_json::from_value(scenario.steps.clone())
                .unwrap_or_else(|e| panic!("{name} steps: {e}"));
            let actual = replay(&scenario.build_id, &steps);

            match (&scenario.expected, update) {
                (Some(expected), false) => {
                    assert_eq!(&actual, expected, "{name} diverged from its golden state");
                }
                _ => {
                    scenario.expected = Some(actual);
                    let encoded =
                        serde_json::to_string_pretty(&scenario).expect("scenario serializes");
                    std::fs::write(&path, format!("{encoded}\n")).expect("fixture writes");
                    assert!(
                        update,
                        "{name} had no golden state; rerun with UPDATE_OBSERVABILITY_FIXTURES=1"
                    );
                }
            }
        }
    }

    #[test]
    fn modes_serialize_as_their_wire_values() {
        assert_eq!(RecoveryMode::Normal.as_str(), "normal");
        assert_eq!(RecoveryMode::Safe.as_str(), "safe");
        assert_eq!(RecoveryMode::Recovering.as_str(), "recovering");
        assert_eq!(
            serde_json::to_string(&RecoveryMode::Recovering).expect("json"),
            "\"recovering\""
        );
    }
}
