//! Binds the event channel catalog to the constants at the app's emit sites.
//!
//! `event_channels` spells every channel name out so the whole catalog reads
//! in one place, and several of those names also have a canonical constant
//! where they are emitted. The constants live in app modules (task
//! workspaces, fleet, perf, codeserver, the sidecar supervisor), so the check
//! lives on the app side of the companion (ADR-0196 P4).

#[cfg(test)]
mod tests {
    use super::super::event_channels::spec_for;

    /// The catalog spells channel names out so the whole set reads in one
    /// place, but several of them already have a canonical constant at the
    /// emit site. Bind the two together: a rename there must not leave a
    /// catalog entry silently matching nothing.
    #[test]
    fn catalog_names_match_their_canonical_constants() {
        for (catalogued, canonical) in [
            (
                "task-workspace://resources-changed",
                crate::task_workspace::RESOURCE_EVENT,
            ),
            ("fleet://update", crate::fleet::UPDATE_EVENT),
            ("perf://frame", crate::perf::sampler::FRAME_EVENT),
            (
                "automation:consent-request",
                super::super::commands::AUTOMATION_CONSENT_CHANNEL,
            ),
            (
                "host-consent://requested",
                super::super::host_consent::CONSENT_CHANNEL,
            ),
            (
                "codeserver://instance-exited",
                crate::codeserver::process::CODESERVER_EXITED_EVENT,
            ),
            (
                "codeserver://editor-event",
                crate::codeserver::agent_channel::CODESERVER_EDITOR_EVENT,
            ),
            (
                "codeserver://broker-request",
                crate::codeserver::agent_channel::CODESERVER_BROKER_REQUEST_EVENT,
            ),
            (
                "codeserver://broker-notification",
                crate::codeserver::agent_channel::CODESERVER_BROKER_NOTIFICATION_EVENT,
            ),
            (
                "codeserver://broker-issue",
                crate::codeserver::agent_channel::CODESERVER_BROKER_ISSUE_EVENT,
            ),
            (
                "codeserver://broker-trace",
                crate::codeserver::agent_channel::CODESERVER_BROKER_TRACE_EVENT,
            ),
            (
                "codeserver://relay-grant-requested",
                crate::codeserver::relay_grants::CODESERVER_RELAY_GRANT_EVENT,
            ),
            (
                "session-import://changed",
                crate::session_import_watch::SESSION_CHANGED_EVENT,
            ),
            ("claude://message", crate::claude::sidecar::SIDECAR_EVENT),
            ("a2ui://dispatch", crate::claude::sidecar::A2UI_EVENT),
            ("agent://message", crate::claude::sidecar::AGENT_EVENT),
        ] {
            assert_eq!(
                catalogued, canonical,
                "catalog entry drifted from the constant at its emit site"
            );
            assert!(
                spec_for(canonical).is_some(),
                "{canonical} lost its catalog entry"
            );
        }
    }
}
