/**
 * Single source of truth for "the user's timezone".
 *
 * Precedence: the explicit profile override (`AppSettings.profile.timezone`)
 * if set, else the device's IANA zone. Every personal-behavior surface that
 * needs the user's own zone — notification DND, pet/twin proactive greetings,
 * goal/schedule pacing defaults — resolves through `resolveUserTimeZone()` so
 * they never drift apart.
 *
 * Note: the scheduler/twin/goal/connector objects keep their OWN per-object
 * `timezone` fields (a cron task may target a different zone than the user).
 * This resolver is only for the *user's own* zone and, at most, the default
 * those per-object pickers fall back to.
 *
 * Zero runtime dependencies (type-only import) so it is safe to pull into the
 * notification runtime, the pet hook, and settings forms alike.
 */

import type { UserProfile } from "@cognia/agent-config-types"

/** The device's IANA timezone (e.g. "America/New_York"), "UTC" on failure. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * The user's preferred IANA timezone: profile override → device zone.
 * Accepts the whole profile (or just its `timezone`) and tolerates
 * `null`/`undefined` so callers can pass `settings?.profile` directly.
 */
export function resolveUserTimeZone(profile?: Pick<UserProfile, "timezone"> | null): string {
  const tz = profile?.timezone?.trim()
  return tz && tz.length > 0 ? tz : deviceTimeZone()
}
