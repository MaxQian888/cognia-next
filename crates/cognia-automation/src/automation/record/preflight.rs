//! Can this machine record right now, and if not, why?
//!
//! Two halves, deliberately separated:
//!
//! - [`RecordPreflight`] is the *report* — every probe the setup screen needs in
//!   order to explain a blocker and link to the right System Settings pane.
//! - [`admission_check`] is the *decision* — pure, and its ordering is the
//!   security contract. Kill switch first, master disable second, everything
//!   else after. `admission_rejects_kill_switch_first` pins that by setting
//!   every fact bad at once and asserting which one wins.
//!
//! Why the order matters: a denial that arrives *after* a consent prompt has
//! been raised is a prompt the user could approve, and approving it would then
//! fail confusingly. The gate itself (`PermissionGate::evaluate`) enforces the
//! same two checks first; this runs before the gate so the recorder-specific
//! blockers (plugin disabled, grants missing, disk full) also never reach a
//! dialog.

use serde::{Deserialize, Serialize};

use super::limits::StorageHeadroom;
use crate::automation::platform::shared::input_monitoring::ProbeState;
use crate::automation::types::{AutomationError, Platform};

/// Stable machine codes. The renderer maps each to localized copy and, where
/// applicable, a settings deep link — so the strings here never reach a user
/// and never need translating.
pub mod blocker {
    pub const KILL_SWITCH: &str = "killSwitchEngaged";
    pub const AUTOMATION_DISABLED: &str = "automationDisabled";
    pub const PLATFORM_UNSUPPORTED: &str = "platformUnsupported";
    pub const PLUGIN_NOT_INSTALLED: &str = "pluginNotInstalled";
    pub const PLUGIN_DISABLED: &str = "pluginDisabled";
    pub const GRANT_MISSING: &str = "grantMissing";
    pub const ALREADY_RECORDING: &str = "alreadyRecording";
    pub const STORAGE_EXHAUSTED: &str = "storageExhausted";
    pub const ACCESSIBILITY: &str = "accessibilityMissing";
    pub const INPUT_MONITORING: &str = "inputMonitoringMissing";
    pub const SCREEN_RECORDING: &str = "screenRecordingMissing";
    pub const UI_AUTOMATION: &str = "uiAutomationUnavailable";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordPreflight {
    pub ready: bool,
    /// Stable codes, most-blocking first.
    pub blockers: Vec<String>,
    pub platform: Platform,
    pub platform_supported: bool,

    pub plugin_installed: bool,
    pub plugin_enabled: bool,
    pub granted: Vec<String>,
    pub missing_grants: Vec<String>,

    pub automation_enabled: bool,
    pub kill_switch_engaged: bool,
    pub already_recording: bool,

    /// macOS Accessibility (AX trust). `NotApplicable` elsewhere.
    pub accessibility: ProbeState,
    /// macOS Input Monitoring. `NotApplicable` elsewhere.
    pub input_monitoring: ProbeState,
    /// macOS Screen Recording. `NotApplicable` elsewhere.
    pub screen_recording: ProbeState,
    /// Windows UI Automation availability. `NotApplicable` elsewhere.
    pub ui_automation: ProbeState,

    /// Local OCR backend ids that are actually available. Empty is normal and
    /// not a blocker — OCR is a fallback for steps accessibility could not
    /// describe, and those steps can be annotated by hand instead.
    pub ocr_backends: Vec<String>,
    pub ocr_available: bool,

    pub storage: StorageHeadroom,
    /// Bundles on disk that were never finished. Surfaced so the setup screen
    /// can offer to resume one instead of silently starting over.
    pub open_bundles: u32,
}

/// The subset of the report that decides admission. Separated from the report so
/// the ordering can be tested without constructing probes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdmissionFacts {
    pub kill_switch: bool,
    pub automation_enabled: bool,
    pub platform_supported: bool,
    pub plugin_installed: bool,
    pub plugin_enabled: bool,
    pub missing_grants: Vec<String>,
    pub already_recording: bool,
    pub storage_exhausted: bool,
}

impl AdmissionFacts {
    /// The all-clear, for tests to perturb one field at a time.
    pub fn ready() -> Self {
        Self {
            kill_switch: false,
            automation_enabled: true,
            platform_supported: true,
            plugin_installed: true,
            plugin_enabled: true,
            missing_grants: Vec::new(),
            already_recording: false,
            storage_exhausted: false,
        }
    }
}

/// May a recording start?
///
/// **The order of these checks is the contract.** Everything here must reject
/// before any consent prompt is raised.
pub fn admission_check(f: &AdmissionFacts) -> Result<(), AutomationError> {
    if f.kill_switch {
        return Err(AutomationError::KillSwitchActive);
    }
    if !f.automation_enabled {
        return Err(AutomationError::PermissionDenied {
            reason: blocker::AUTOMATION_DISABLED.into(),
        });
    }
    if !f.platform_supported {
        return Err(AutomationError::UnsupportedPlatform);
    }
    if !f.plugin_installed {
        return Err(AutomationError::PermissionDenied {
            reason: blocker::PLUGIN_NOT_INSTALLED.into(),
        });
    }
    if !f.plugin_enabled {
        return Err(AutomationError::PermissionDenied {
            reason: blocker::PLUGIN_DISABLED.into(),
        });
    }
    if let Some(first) = f.missing_grants.first() {
        return Err(AutomationError::PermissionDenied {
            reason: format!("{}:{first}", blocker::GRANT_MISSING),
        });
    }
    if f.already_recording {
        return Err(AutomationError::BackendError {
            message: blocker::ALREADY_RECORDING.into(),
        });
    }
    if f.storage_exhausted {
        return Err(AutomationError::BackendError {
            message: blocker::STORAGE_EXHAUSTED.into(),
        });
    }
    Ok(())
}

/// Only the codes a user can act on. Probe states that are merely `Unknown` are
/// reported in the body but do not block: failing a start on "we could not ask"
/// would strand users whose grants are actually fine.
pub fn probe_blockers(p: &RecordPreflight) -> Vec<String> {
    let mut out = Vec::new();
    if p.accessibility == ProbeState::Missing {
        out.push(blocker::ACCESSIBILITY.into());
    }
    if p.input_monitoring == ProbeState::Missing {
        out.push(blocker::INPUT_MONITORING.into());
    }
    if p.screen_recording == ProbeState::Missing {
        out.push(blocker::SCREEN_RECORDING.into());
    }
    if p.ui_automation == ProbeState::Missing {
        out.push(blocker::UI_AUTOMATION.into());
    }
    out
}

/// Assemble the report's verdict from the admission facts plus the probes.
pub fn finalize(mut report: RecordPreflight, facts: &AdmissionFacts) -> RecordPreflight {
    let mut blockers = Vec::new();
    if let Err(err) = admission_check(facts) {
        blockers.push(match &err {
            AutomationError::KillSwitchActive => blocker::KILL_SWITCH.to_string(),
            AutomationError::UnsupportedPlatform => blocker::PLATFORM_UNSUPPORTED.to_string(),
            AutomationError::PermissionDenied { reason } => reason.clone(),
            AutomationError::BackendError { message } => message.clone(),
            other => other.to_string(),
        });
    }
    blockers.extend(probe_blockers(&report));
    report.ready = blockers.is_empty();
    report.blockers = blockers;
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::record::limits::RecordLimits;
    use crate::automation::record::plugin_facts::{missing_grants, PluginFacts};

    fn empty_report() -> RecordPreflight {
        let limits = RecordLimits::default();
        RecordPreflight {
            ready: false,
            blockers: Vec::new(),
            platform: Platform::Macos,
            platform_supported: true,
            plugin_installed: true,
            plugin_enabled: true,
            granted: Vec::new(),
            missing_grants: Vec::new(),
            automation_enabled: true,
            kill_switch_engaged: false,
            already_recording: false,
            accessibility: ProbeState::Ok,
            input_monitoring: ProbeState::Ok,
            screen_recording: ProbeState::Ok,
            ui_automation: ProbeState::NotApplicable,
            ocr_backends: vec!["apple-vision".into()],
            ocr_available: true,
            storage: StorageHeadroom {
                used_bytes: 0,
                global_limit_bytes: limits.max_global_bytes,
                bundle_limit_bytes: limits.max_bundle_bytes,
                free_disk_bytes: None,
            },
            open_bundles: 0,
        }
    }

    #[test]
    fn admission_rejects_kill_switch_first() {
        // Every fact bad at once. The kill switch must still be the answer —
        // that is what makes "engaged means nothing can start" unconditional.
        let facts = AdmissionFacts {
            kill_switch: true,
            automation_enabled: false,
            platform_supported: false,
            plugin_installed: false,
            plugin_enabled: false,
            missing_grants: vec!["native:input".into()],
            already_recording: true,
            storage_exhausted: true,
        };
        assert!(matches!(
            admission_check(&facts),
            Err(AutomationError::KillSwitchActive)
        ));
    }

    #[test]
    fn admission_rejects_disabled_automation_before_plugin_checks() {
        let facts = AdmissionFacts {
            automation_enabled: false,
            plugin_installed: false,
            ..AdmissionFacts::ready()
        };
        match admission_check(&facts) {
            Err(AutomationError::PermissionDenied { reason }) => {
                assert_eq!(reason, blocker::AUTOMATION_DISABLED)
            }
            other => panic!("expected the master disable to win, got {other:?}"),
        }
    }

    #[test]
    fn admission_rejects_unsupported_platform_before_plugin_checks() {
        let facts = AdmissionFacts {
            platform_supported: false,
            plugin_enabled: false,
            ..AdmissionFacts::ready()
        };
        assert!(matches!(
            admission_check(&facts),
            Err(AutomationError::UnsupportedPlatform)
        ));
    }

    #[test]
    fn admission_distinguishes_not_installed_from_disabled() {
        let not_installed = AdmissionFacts {
            plugin_installed: false,
            ..AdmissionFacts::ready()
        };
        match admission_check(&not_installed) {
            Err(AutomationError::PermissionDenied { reason }) => {
                assert_eq!(reason, blocker::PLUGIN_NOT_INSTALLED)
            }
            other => panic!("unexpected {other:?}"),
        }

        let disabled = AdmissionFacts {
            plugin_enabled: false,
            ..AdmissionFacts::ready()
        };
        match admission_check(&disabled) {
            Err(AutomationError::PermissionDenied { reason }) => {
                assert_eq!(reason, blocker::PLUGIN_DISABLED)
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn admission_names_the_missing_grant() {
        let facts = AdmissionFacts {
            missing_grants: vec!["native:screen".into()],
            ..AdmissionFacts::ready()
        };
        match admission_check(&facts) {
            Err(AutomationError::PermissionDenied { reason }) => {
                assert_eq!(reason, "grantMissing:native:screen")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn admission_rejects_a_concurrent_recording() {
        let facts = AdmissionFacts {
            already_recording: true,
            ..AdmissionFacts::ready()
        };
        match admission_check(&facts) {
            Err(AutomationError::BackendError { message }) => {
                assert_eq!(message, blocker::ALREADY_RECORDING)
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn admission_rejects_exhausted_storage_last() {
        let facts = AdmissionFacts {
            storage_exhausted: true,
            ..AdmissionFacts::ready()
        };
        match admission_check(&facts) {
            Err(AutomationError::BackendError { message }) => {
                assert_eq!(message, blocker::STORAGE_EXHAUSTED)
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_ready_machine_is_admitted() {
        assert!(admission_check(&AdmissionFacts::ready()).is_ok());
    }

    #[test]
    fn probe_blockers_ignore_unknown_states() {
        let mut report = empty_report();
        report.accessibility = ProbeState::Unknown;
        report.input_monitoring = ProbeState::Unknown;
        assert!(
            probe_blockers(&report).is_empty(),
            "'could not ask' must not strand a user whose grants are fine"
        );
    }

    #[test]
    fn probe_blockers_report_each_missing_permission() {
        let mut report = empty_report();
        report.accessibility = ProbeState::Missing;
        report.screen_recording = ProbeState::Missing;
        assert_eq!(
            probe_blockers(&report),
            vec![blocker::ACCESSIBILITY, blocker::SCREEN_RECORDING]
        );
    }

    #[test]
    fn finalize_marks_ready_when_nothing_blocks() {
        let report = finalize(empty_report(), &AdmissionFacts::ready());
        assert!(report.ready);
        assert!(report.blockers.is_empty());
    }

    #[test]
    fn finalize_combines_admission_and_probe_blockers() {
        let mut report = empty_report();
        report.input_monitoring = ProbeState::Missing;
        let facts = AdmissionFacts {
            plugin_enabled: false,
            ..AdmissionFacts::ready()
        };
        let report = finalize(report, &facts);
        assert!(!report.ready);
        assert_eq!(
            report.blockers,
            vec![blocker::PLUGIN_DISABLED, blocker::INPUT_MONITORING]
        );
    }

    #[test]
    fn missing_ocr_is_not_a_blocker() {
        // Windows ships a placeholder OCR backend today. Reporting that honestly
        // is right; refusing to record because of it is not — those steps can be
        // annotated by hand at review.
        let mut report = empty_report();
        report.ocr_available = false;
        report.ocr_backends.clear();
        let report = finalize(report, &AdmissionFacts::ready());
        assert!(report.ready);
    }

    #[test]
    fn preflight_serializes_camel_case() {
        let json = serde_json::to_string(&empty_report()).unwrap();
        assert!(json.contains("\"platformSupported\":true"));
        assert!(json.contains("\"missingGrants\":[]"));
        assert!(json.contains("\"inputMonitoring\":\"ok\""));
        assert!(json.contains("\"openBundles\":0"));
        let back: RecordPreflight = serde_json::from_str(&json).unwrap();
        assert_eq!(back, empty_report());
    }

    #[test]
    fn blocker_codes_are_stable_identifiers() {
        // These reach the renderer as i18n keys. Renaming one silently degrades
        // a localized explanation into a raw code.
        assert_eq!(blocker::KILL_SWITCH, "killSwitchEngaged");
        assert_eq!(blocker::GRANT_MISSING, "grantMissing");
        assert_eq!(blocker::SCREEN_RECORDING, "screenRecordingMissing");
    }

    #[test]
    fn missing_grants_helper_feeds_the_admission_facts() {
        let facts = PluginFacts {
            installed: true,
            enabled: true,
            granted: vec!["native:input".into()],
        };
        let admission = AdmissionFacts {
            missing_grants: missing_grants(&facts),
            ..AdmissionFacts::ready()
        };
        assert!(admission_check(&admission).is_err());
    }
}
