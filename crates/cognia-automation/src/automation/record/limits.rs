//! Hard caps on a recording, enforced natively.
//!
//! Four independent budgets — wall-clock, step count, this bundle's bytes, and
//! every bundle's bytes together. Each warns once at 80% and stops the session
//! safely (journal preserved, draft recoverable) at 100%.
//!
//! Two design notes worth keeping:
//!
//! - **Integer ratio, not a float.** `used * 10 >= limit * 8` has no rounding
//!   behaviour to argue about at the boundary, and `LimitTracker` is the kind of
//!   code where a one-frame drift becomes a support ticket.
//! - **Pre-check, not post-check.** [`LimitTracker::would_breach`] runs *before*
//!   a frame is written, so we refuse the write rather than discovering we blew
//!   past a 250 MiB cap by one 2 MiB PNG. Overshoot is the normal failure of a
//!   post-check quota and it is exactly what the disk-space guarantee cannot
//!   afford.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const MAX_DURATION_MS: i64 = 60 * 60 * 1000;
pub const MAX_STEPS: u32 = 500;
pub const MAX_BUNDLE_BYTES: u64 = 250 * 1024 * 1024;
pub const MAX_GLOBAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Warn at 80%, expressed as a fraction so the comparison stays in integers.
pub const WARN_RATIO_NUM: u64 = 8;
pub const WARN_RATIO_DEN: u64 = 10;

/// Rough per-frame estimate used by the pre-check when the encoded size is not
/// yet known. A 1280x800 PNG of a typical UI lands well under this.
pub const ESTIMATED_FRAME_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordLimits {
    pub max_duration_ms: i64,
    pub max_steps: u32,
    pub max_bundle_bytes: u64,
    pub max_global_bytes: u64,
}

impl Default for RecordLimits {
    fn default() -> Self {
        Self {
            max_duration_ms: MAX_DURATION_MS,
            max_steps: MAX_STEPS,
            max_bundle_bytes: MAX_BUNDLE_BYTES,
            max_global_bytes: MAX_GLOBAL_BYTES,
        }
    }
}

impl RecordLimits {
    /// A caller may only *tighten* the defaults. The renderer supplies these,
    /// and a renderer that could raise them would make the cap advisory —
    /// which is the same as not having one.
    pub fn clamped(self) -> Self {
        let d = Self::default();
        Self {
            max_duration_ms: self.max_duration_ms.clamp(1, d.max_duration_ms),
            max_steps: self.max_steps.clamp(1, d.max_steps),
            max_bundle_bytes: self.max_bundle_bytes.clamp(1, d.max_bundle_bytes),
            max_global_bytes: self.max_global_bytes.clamp(1, d.max_global_bytes),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum LimitKind {
    Duration,
    Steps,
    BundleBytes,
    GlobalBytes,
}

impl LimitKind {
    pub const ALL: [LimitKind; 4] = [
        LimitKind::Duration,
        LimitKind::Steps,
        LimitKind::BundleBytes,
        LimitKind::GlobalBytes,
    ];

    fn index(self) -> usize {
        match self {
            LimitKind::Duration => 0,
            LimitKind::Steps => 1,
            LimitKind::BundleBytes => 2,
            LimitKind::GlobalBytes => 3,
        }
    }
}

/// One budget's current standing. `used`/`limit` are unitless on the wire; the
/// renderer formats by `kind` (ms, steps, bytes).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LimitUsage {
    pub kind: LimitKind,
    pub used: u64,
    pub limit: u64,
}

impl LimitUsage {
    pub fn is_warning(&self) -> bool {
        self.limit > 0 && self.used.saturating_mul(WARN_RATIO_DEN) >= self.limit * WARN_RATIO_NUM
    }

    pub fn is_breach(&self) -> bool {
        self.used >= self.limit
    }
}

#[derive(Debug, Clone)]
pub struct LimitTracker {
    limits: RecordLimits,
    started_at: i64,
    steps: u32,
    bundle_bytes: u64,
    /// Bytes every *other* bundle occupied when this session started. Held
    /// constant for the session so the global budget can be computed without
    /// re-walking the recordings directory on every step.
    other_bundles_bytes: u64,
    warned: [bool; 4],
}

impl LimitTracker {
    pub fn new(limits: RecordLimits, started_at: i64, other_bundles_bytes: u64) -> Self {
        Self {
            limits: limits.clamped(),
            started_at,
            steps: 0,
            bundle_bytes: 0,
            other_bundles_bytes,
            warned: [false; 4],
        }
    }

    pub fn limits(&self) -> RecordLimits {
        self.limits
    }

    pub fn step_count(&self) -> u32 {
        self.steps
    }

    pub fn bundle_bytes(&self) -> u64 {
        self.bundle_bytes
    }

    fn usage_at(&self, now_ms: i64, extra_steps: u32, extra_bytes: u64) -> [LimitUsage; 4] {
        let elapsed = now_ms.saturating_sub(self.started_at).max(0) as u64;
        let steps = self.steps.saturating_add(extra_steps) as u64;
        let bundle = self.bundle_bytes.saturating_add(extra_bytes);
        [
            LimitUsage {
                kind: LimitKind::Duration,
                used: elapsed,
                limit: self.limits.max_duration_ms as u64,
            },
            LimitUsage {
                kind: LimitKind::Steps,
                used: steps,
                limit: self.limits.max_steps as u64,
            },
            LimitUsage {
                kind: LimitKind::BundleBytes,
                used: bundle,
                limit: self.limits.max_bundle_bytes,
            },
            LimitUsage {
                kind: LimitKind::GlobalBytes,
                used: self.other_bundles_bytes.saturating_add(bundle),
                limit: self.limits.max_global_bytes,
            },
        ]
    }

    /// Current standing across all four budgets. Surfaced on `RecordStatus` so
    /// the floating controller can show a capacity bar without polling.
    pub fn snapshot(&self, now_ms: i64) -> Vec<LimitUsage> {
        self.usage_at(now_ms, 0, 0).to_vec()
    }

    /// Would committing a frame of `pending_bytes` cross any cap? Called before
    /// the write; `Some(usage)` means skip the frame.
    pub fn would_breach(&self, now_ms: i64, pending_bytes: u64) -> Option<LimitUsage> {
        self.usage_at(now_ms, 1, pending_bytes)
            .into_iter()
            .find(|u| u.is_breach())
    }

    /// Record a committed step. Returns the warnings that fired for the first
    /// time on this step, plus the breach that ends the session, if any.
    pub fn observe(
        &mut self,
        now_ms: i64,
        added_bytes: u64,
    ) -> (Vec<LimitUsage>, Option<LimitUsage>) {
        self.steps = self.steps.saturating_add(1);
        self.bundle_bytes = self.bundle_bytes.saturating_add(added_bytes);

        let usage = self.usage_at(now_ms, 0, 0);
        let mut warnings = Vec::new();
        let mut breach = None;
        for u in usage {
            if breach.is_none() && u.is_breach() {
                breach = Some(u);
            }
            if u.is_warning() && !self.warned[u.kind.index()] {
                self.warned[u.kind.index()] = true;
                warnings.push(u);
            }
        }
        (warnings, breach)
    }

    /// Duration is the one budget that advances with no step to hang a check on.
    /// The drain loop calls this on its idle tick.
    pub fn check_elapsed(&mut self, now_ms: i64) -> (Vec<LimitUsage>, Option<LimitUsage>) {
        let usage = self.usage_at(now_ms, 0, 0);
        let duration = usage[LimitKind::Duration.index()];
        let mut warnings = Vec::new();
        if duration.is_warning() && !self.warned[LimitKind::Duration.index()] {
            self.warned[LimitKind::Duration.index()] = true;
            warnings.push(duration);
        }
        let breach = duration.is_breach().then_some(duration);
        (warnings, breach)
    }
}

/// Storage picture for `record_preflight`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageHeadroom {
    pub used_bytes: u64,
    pub global_limit_bytes: u64,
    pub bundle_limit_bytes: u64,
    /// `None` when the platform will not tell us. Absence is reported as-is
    /// rather than guessed — a fabricated free-space number would silently
    /// admit a recording that then dies mid-flight.
    pub free_disk_bytes: Option<u64>,
}

impl StorageHeadroom {
    /// No room left for even a minimal recording.
    pub fn is_exhausted(&self) -> bool {
        self.used_bytes >= self.global_limit_bytes
    }

    pub fn remaining_bytes(&self) -> u64 {
        self.global_limit_bytes.saturating_sub(self.used_bytes)
    }
}

/// Sum of every bundle under `root`.
pub fn global_bundle_bytes(root: &Path) -> u64 {
    super::assets::dir_bytes(root)
}

/// Bytes occupied by every bundle *except* `exclude` — the baseline a live
/// session's global budget is measured against.
pub fn other_bundle_bytes(root: &Path, exclude: &super::assets::RecordingId) -> u64 {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == exclude.as_str() {
            continue;
        }
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => {
                total = total.saturating_add(super::assets::dir_bytes(&entry.path()))
            }
            Ok(meta) => total = total.saturating_add(meta.len()),
            Err(_) => {}
        }
    }
    total
}

pub fn storage_headroom(root: &Path, limits: RecordLimits) -> StorageHeadroom {
    StorageHeadroom {
        used_bytes: global_bundle_bytes(root),
        global_limit_bytes: limits.max_global_bytes,
        bundle_limit_bytes: limits.max_bundle_bytes,
        free_disk_bytes: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> LimitTracker {
        LimitTracker::new(RecordLimits::default(), 0, 0)
    }

    #[test]
    fn warn_fires_once_per_kind_at_eighty_percent() {
        let mut t = LimitTracker::new(
            RecordLimits {
                max_steps: 10,
                ..RecordLimits::default()
            },
            0,
            0,
        );
        for _ in 0..7 {
            let (warnings, breach) = t.observe(1, 0);
            assert!(warnings.is_empty(), "no warning below 80%");
            assert!(breach.is_none());
        }
        let (warnings, _) = t.observe(1, 0); // 8/10 — exactly 80%
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].kind, LimitKind::Steps);

        let (warnings, _) = t.observe(1, 0); // 9/10 — still over 80%
        assert!(warnings.is_empty(), "each kind warns exactly once");
    }

    #[test]
    fn step_limit_breach_at_exactly_the_cap() {
        let mut t = LimitTracker::new(
            RecordLimits {
                max_steps: 3,
                ..RecordLimits::default()
            },
            0,
            0,
        );
        assert!(t.observe(1, 0).1.is_none());
        assert!(t.observe(1, 0).1.is_none());
        let (_, breach) = t.observe(1, 0);
        let breach = breach.expect("the 3rd of 3 steps breaches");
        assert_eq!(breach.kind, LimitKind::Steps);
        assert_eq!(breach.used, 3);
    }

    #[test]
    fn duration_breach_at_exactly_sixty_minutes() {
        let mut t = tracker();
        let (_, breach) = t.check_elapsed(MAX_DURATION_MS - 1);
        assert!(breach.is_none());
        let (_, breach) = t.check_elapsed(MAX_DURATION_MS);
        assert_eq!(breach.map(|b| b.kind), Some(LimitKind::Duration));
    }

    #[test]
    fn duration_warns_on_the_idle_tick() {
        let mut t = tracker();
        let (warnings, _) = t.check_elapsed(MAX_DURATION_MS * 8 / 10);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].kind, LimitKind::Duration);
        let (warnings, _) = t.check_elapsed(MAX_DURATION_MS * 9 / 10);
        assert!(warnings.is_empty());
    }

    #[test]
    fn would_breach_refuses_the_frame_that_would_cross_the_cap() {
        let t = LimitTracker::new(
            RecordLimits {
                max_bundle_bytes: 1000,
                ..RecordLimits::default()
            },
            0,
            0,
        );
        assert!(
            t.would_breach(1, 999).is_none(),
            "a fitting frame is allowed"
        );
        let refused = t
            .would_breach(1, 1000)
            .expect("the crossing frame is refused");
        assert_eq!(refused.kind, LimitKind::BundleBytes);
    }

    #[test]
    fn would_breach_counts_the_pending_step() {
        let t = LimitTracker::new(
            RecordLimits {
                max_steps: 1,
                ..RecordLimits::default()
            },
            0,
            0,
        );
        // Zero steps recorded, but committing one would reach the cap of one.
        assert_eq!(t.would_breach(1, 0).map(|u| u.kind), Some(LimitKind::Steps));
    }

    #[test]
    fn global_cap_counts_other_bundles() {
        let mut t = LimitTracker::new(
            RecordLimits {
                max_global_bytes: 1000,
                max_bundle_bytes: 1000,
                ..RecordLimits::default()
            },
            0,
            900, // another bundle already on disk
        );
        let (_, breach) = t.observe(1, 100);
        let breach = breach.expect("this bundle's 100 bytes tip the global cap");
        assert_eq!(breach.kind, LimitKind::GlobalBytes);
        assert_eq!(breach.used, 1000);
    }

    #[test]
    fn caller_limits_may_tighten_never_loosen() {
        let loosened = RecordLimits {
            max_duration_ms: MAX_DURATION_MS * 10,
            max_steps: MAX_STEPS * 10,
            max_bundle_bytes: MAX_BUNDLE_BYTES * 10,
            max_global_bytes: MAX_GLOBAL_BYTES * 10,
        }
        .clamped();
        assert_eq!(loosened, RecordLimits::default());

        let tightened = RecordLimits {
            max_duration_ms: 60_000,
            max_steps: 20,
            max_bundle_bytes: 1024,
            max_global_bytes: 4096,
        };
        assert_eq!(tightened.clamped(), tightened);
    }

    #[test]
    fn clamped_rejects_zero_and_negative() {
        let zeroed = RecordLimits {
            max_duration_ms: 0,
            max_steps: 0,
            max_bundle_bytes: 0,
            max_global_bytes: 0,
        }
        .clamped();
        assert_eq!(zeroed.max_duration_ms, 1);
        assert_eq!(zeroed.max_steps, 1);
        assert_eq!(zeroed.max_bundle_bytes, 1);

        let negative = RecordLimits {
            max_duration_ms: -5,
            ..RecordLimits::default()
        }
        .clamped();
        assert_eq!(negative.max_duration_ms, 1);
    }

    #[test]
    fn warn_ratio_is_integer_math() {
        // 80% of 7 is 5.6; the integer form must fire at 6, not at a rounded 5.
        let below = LimitUsage {
            kind: LimitKind::Steps,
            used: 5,
            limit: 7,
        };
        let at = LimitUsage {
            kind: LimitKind::Steps,
            used: 6,
            limit: 7,
        };
        assert!(!below.is_warning());
        assert!(at.is_warning());
    }

    #[test]
    fn zero_limit_never_warns() {
        let u = LimitUsage {
            kind: LimitKind::Steps,
            used: 0,
            limit: 0,
        };
        assert!(
            !u.is_warning(),
            "a zero limit must not divide-by-zero into a warning"
        );
    }

    #[test]
    fn snapshot_reports_all_four_budgets() {
        let t = tracker();
        let snap = t.snapshot(1000);
        assert_eq!(snap.len(), 4);
        let kinds: Vec<_> = snap.iter().map(|u| u.kind).collect();
        for kind in LimitKind::ALL {
            assert!(kinds.contains(&kind), "{kind:?} must be reported");
        }
    }

    #[test]
    fn elapsed_never_goes_negative_on_clock_skew() {
        let t = LimitTracker::new(RecordLimits::default(), 10_000, 0);
        let snap = t.snapshot(0); // clock jumped backwards
        assert_eq!(snap[0].used, 0);
    }

    #[test]
    fn other_bundle_bytes_excludes_the_live_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = super::super::assets::RecordingId::new();
        let theirs = super::super::assets::RecordingId::new();
        std::fs::create_dir_all(tmp.path().join(mine.as_str())).unwrap();
        std::fs::create_dir_all(tmp.path().join(theirs.as_str())).unwrap();
        std::fs::write(tmp.path().join(mine.as_str()).join("a"), vec![0u8; 100]).unwrap();
        std::fs::write(tmp.path().join(theirs.as_str()).join("a"), vec![0u8; 40]).unwrap();

        assert_eq!(other_bundle_bytes(tmp.path(), &mine), 40);
        assert_eq!(global_bundle_bytes(tmp.path()), 140);
    }

    #[test]
    fn storage_headroom_reports_exhaustion() {
        let tmp = tempfile::tempdir().unwrap();
        let head = storage_headroom(
            tmp.path(),
            RecordLimits {
                max_global_bytes: 1,
                ..RecordLimits::default()
            },
        );
        assert!(!head.is_exhausted(), "an empty root has room");
        assert_eq!(head.remaining_bytes(), 1);

        let full = StorageHeadroom {
            used_bytes: 10,
            global_limit_bytes: 10,
            bundle_limit_bytes: 10,
            free_disk_bytes: None,
        };
        assert!(full.is_exhausted());
        assert_eq!(full.remaining_bytes(), 0);
    }

    #[test]
    fn limits_serialize_camel_case() {
        let json = serde_json::to_string(&RecordLimits::default()).unwrap();
        assert!(json.contains("\"maxDurationMs\""));
        assert!(json.contains("\"maxBundleBytes\""));
        let back: RecordLimits = serde_json::from_str(&json).unwrap();
        assert_eq!(back, RecordLimits::default());
    }

    #[test]
    fn limit_usage_serializes_camel_case() {
        let json = serde_json::to_string(&LimitUsage {
            kind: LimitKind::GlobalBytes,
            used: 1,
            limit: 2,
        })
        .unwrap();
        assert!(json.contains("\"kind\":\"globalBytes\""));
        assert!(json.contains("\"used\":1"));
    }
}
