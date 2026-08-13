//! GENERATED FILE — DO NOT EDIT.
//!
//! Source: `packages/agent-config-types/src/settings-sync.ts`
//! Generator: `scripts/build/gen-settings-sync.mjs` (CI runs it with `--check`)
//!
//! The allowlist below is every `AppSettings` field classified `shared`: a
//! paired client may write it to its host through `app_settings_update`, and
//! the host mirrors it back down through `sync_pull`. Everything else is
//! rejected with `400 validation_failed`.
//!
//! Fields deliberately excluded, and why — so a reader who expects one here
//! finds the reason instead of assuming an oversight:
//!
//! `iceServers` — server-authoritative (mirrored down, never accepted up).
//!   STUN set belongs to the deployment, not the handset. A self-hosted STUN configured on the
//!   host has to reach every paired client or NAT traversal silently degrades.
//!
//! `remoteBrowserEnabled` — server-authoritative (mirrored down, never accepted up).
//!   The desktop owns the remote-browser gate (profiles + granted domains live there). The
//!   phone only reads it to decide whether to render the remote preview pane, so it must flow
//!   down, never up.
//!
//! `signalingUrl` — server-authoritative (mirrored down, never accepted up).
//!   Rendezvous endpoint. Both peers must dial the same server, and the desktop/cloud host is
//!   the one that knows which signaling deployment it is registered with. Mirroring it down is
//!   what makes a self-hosted signaling server reach the phone at all (previously the phone
//!   always fell back to DEFAULT_SIGNALING_URL).
//!
//! `turnServers` — server-authoritative (mirrored down, never accepted up).
//!   Static TURN relays belong to the deployment. Without mirroring, a phone behind symmetric
//!   NAT can never use the operator's relay and WebRTC simply fails.
//!
//! `biometricRequiredFor` — device-local (never crosses the wire).
//!   Gating is a property of this device's own authenticator (Face ID / Touch ID / none).
//!   Mirroring one device's policy onto another would silently weaken it, or lock out a device
//!   with no biometric hardware at all.
//!
//! `mobileRuntimeMode` — device-local (never crosses the wire).
//!   Standalone (BYOK) vs paired (companion) is what this handset is doing right now; it has no
//!   meaning on any other device (ADR-0056).
//!
//! `pinnedMeRowIds` — device-local (never crosses the wire).
//!   Favourites of the mobile `/me` list. The desktop has no `/me` surface, so there is nothing
//!   on the other side to mirror to or from.
//!
//! `selectedMicId` — device-local (never crosses the wire).
//!   An OS-issued input-device identifier. The desktop's microphone id addresses nothing on the
//!   phone.
//!
//! `webrtcEnabled` — device-local (never crosses the wire).
//!   Whether to attempt the WebRTC tier is a per-device transport choice — a desktop on wired
//!   ethernet and a phone on cellular want different answers. The endpoints it dials are
//!   server-authoritative; the opt-in is not.
//!
//! `workflowEditorPerformanceTier` — device-local (never crosses the wire).
//!   A motion/computation budget chosen for this device's GPU and CPU. A desktop's `high` tier
//!   applied to a phone is exactly the wrong answer.
//!
//! Every other `AppSettings` field is `desktop-only`: credentials, filesystem
//! paths, desktop-only subsystems, and internal bookkeeping that are not part
//! of the mobile contract at all.

/// Allowlisted patch keys for `app_settings_update`.
pub const APP_SETTINGS_MOBILE_ALLOWED_KEYS: &[&str] = &[
    "a11y",
    "accentColor",
    "activeCustomThemeId",
    "activePluginThemeId",
    "autoMode",
    "bareMode",
    "briefMode",
    "cartesiaVoice",
    "colorTheme",
    "compaction",
    "composerBehavior",
    "conversationSidebar",
    "conversationTimeline",
    "conversationTitle",
    "customCss",
    "customCssEnabled",
    "customThemes",
    "debugMode",
    "deepgramVoice",
    "defaultMaxThinkingTokens",
    "defaultModel",
    "defaultSearchProvider",
    "defaultSystemPrompt",
    "density",
    "edgeVoice",
    "elevenlabsVoice",
    "evalSettings",
    "fontScale",
    "geminiVoice",
    "humeVoice",
    "importedVscodeThemes",
    "instructions",
    "language",
    "lastInboxViewedAt",
    "lmntVoice",
    "messageDisplay",
    "mistralVoiceId",
    "mobileComputerUseEnabled",
    "motion",
    "notificationPreferences",
    "openaiVoice",
    "permissionMode",
    "pinnedWorkflowIds",
    "profile",
    "radius",
    "reduceMotion",
    "searchEnabled",
    "searchFallbackEnabled",
    "searchMaxResults",
    "sidebarLayout",
    "streamPartialMessages",
    "sttLanguage",
    "surfaceSkillsEnabled",
    "systemVoice",
    "telemetryEnabled",
    "theme",
    "ttsAutoPlay",
    "ttsEnabled",
    "ttsPitch",
    "ttsProvider",
    "ttsRate",
    "ttsVolume",
    "typographyExt",
    "wallpapers",
    "xiaomiVoice",
];

#[cfg(test)]
mod tests {
    use super::APP_SETTINGS_MOBILE_ALLOWED_KEYS;

    /// The `--check` gate proves this file matches the table it came from.
    /// These prove the shape the RPC handler relies on, which no amount of
    /// regeneration guarantees on its own.
    #[test]
    fn the_allowlist_is_usable_as_a_lookup() {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.is_empty(),
            "an empty allowlist would reject every mobile settings write"
        );
        let mut seen = std::collections::BTreeSet::new();
        for key in APP_SETTINGS_MOBILE_ALLOWED_KEYS {
            assert!(!key.trim().is_empty(), "a blank key would match nothing");
            assert!(seen.insert(*key), "duplicate allowlist entry: {key}");
        }
        let sorted: Vec<&str> = seen.iter().copied().collect();
        assert_eq!(
            sorted.as_slice(),
            APP_SETTINGS_MOBILE_ALLOWED_KEYS,
            "the generator emits sorted keys; an unsorted list means a hand edit"
        );
    }

    /// Server-authoritative and device-local fields flow the other way, or not
    /// at all. Accepting one here is the leak the classification table exists
    /// to prevent, so it is asserted rather than left to review.
    #[test]
    fn nothing_that_must_not_travel_upward_is_allowlisted() {
        for forbidden in [
            "iceServers",
            "turnServers",
            "turnProvider",
            "signalingUrl",
            "remoteBrowserEnabled",
            "biometricRequiredFor",
            "workflowEditorPerformanceTier",
            "selectedMicId",
            "apiKey",
        ] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&forbidden),
                "{forbidden} must not be writable from a paired client"
            );
        }
    }
}
