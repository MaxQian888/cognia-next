/**
 * Grant windows offered by the two computer-use consent surfaces (the desktop
 * `<ConsentOverlay>` and the phone `<MobileConsentSheet>`).
 *
 * A "don't ask again" decision used to last until the app quit or the kill
 * switch fired. That is too much authority to hand out from a lock screen, so
 * the grant is now time-boxed: the operator picks a window, and the Rust broker
 * (`ConsentBroker::resolve`) stamps an expiry on the grant.
 *
 * The broker independently clamps whatever it receives to
 * `MAX_GRANT_DURATION_MS` — these values are the offered menu, not the
 * enforcement. Keep the ceiling here in step with that constant.
 */

const MINUTE_MS = 60_000

/** Selectable grant windows, ascending. */
export const CONSENT_GRANT_DURATIONS_MS = [15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS] as const

export type ConsentGrantDurationMs = (typeof CONSENT_GRANT_DURATIONS_MS)[number]

/** Pre-selected window. Long enough to be useful, short enough to forget about. */
export const DEFAULT_CONSENT_GRANT_DURATION_MS: ConsentGrantDurationMs = 30 * MINUTE_MS

/**
 * Mirror of the Rust `MAX_GRANT_DURATION_MS` ceiling
 * (`crates/cognia-automation/src/automation/consent.rs`). Anything longer is
 * clamped host-side, so offering it would silently mislead the operator.
 */
export const MAX_CONSENT_GRANT_DURATION_MS = 60 * MINUTE_MS

/** Whole minutes in a grant window — the unit both surfaces label buttons with. */
export function grantDurationMinutes(ms: number): number {
  return Math.round(ms / MINUTE_MS)
}

/**
 * Bounds for `AutomationSettings.consentTimeoutMs` — how long a prompt waits
 * before fail-closing. Mirrors the Rust `MIN_/MAX_/DEFAULT_CONSENT_TIMEOUT_MS`
 * in `crates/cognia-automation/src/automation/permission.rs`.
 *
 * The ceiling exists because the sidecar aborts a plugin tool call at 120s
 * (`sidecar/builtin-tools/plugin-tools.mjs`). A consent window past that would
 * let the operator answer a call that already died, so the settings input must
 * not offer it.
 */
export const MIN_CONSENT_TIMEOUT_MS = 5_000
export const MAX_CONSENT_TIMEOUT_MS = 115_000
export const DEFAULT_CONSENT_TIMEOUT_MS = 90_000

/** Clamp a settings-supplied consent timeout the same way the host does. */
export function clampConsentTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CONSENT_TIMEOUT_MS
  return Math.min(Math.max(ms, MIN_CONSENT_TIMEOUT_MS), MAX_CONSENT_TIMEOUT_MS)
}
