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

/**
 * The zone a formatting provider (`NextIntlClientProvider`) should print in:
 * the user's zone, validated. A profile override is free text as far as this
 * layer knows, and an unknown zone makes every `Intl.DateTimeFormat` call
 * throw — so a value the runtime rejects falls back to the device zone rather
 * than taking every formatted date in the app down with it. The result is the
 * runtime's canonical spelling of the zone.
 */
export function resolveFormattingTimeZone(profile?: Pick<UserProfile, "timezone"> | null): string {
  const zone = resolveUserTimeZone(profile)
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return deviceTimeZone()
  }
}
