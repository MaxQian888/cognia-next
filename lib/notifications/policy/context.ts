// Notification V2 policy context — derives the durable `NotificationPolicyContext`
// the planner commits decisions against, from the operator's stored
// notification preferences.
//
// `policyVersion` is the replay-detection key: a decision carries the version
// it was planned under so a later settings change can be told apart from a
// stale decision. We derive it as a content hash of the policy inputs —
// identical prefs ⇒ identical version (the planner's `inputHash` dedupes
// no-op replans), any change ⇒ a new version (reprojection is forced through
// `bumpProjectionGeneration`, not by trusting a counter).

import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { NotificationPreferences } from "@/types/notifications"
import { stableHash } from "../result/materiality"

/** Default IANA timezone when none is configured — the host's local zone. */
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * Build the planner's policy context from resolved preferences. `policyVersion`
 * is a stable int derived from the policy inputs — two calls with identical
 * prefs produce the same version (so a no-change replan dedupes), a settings
 * edit produces a new one (so a stale decision is detectable).
 */
export function notificationPolicyContext(
  prefs: NotificationPreferences,
  opts: { timezone?: string } = {}
): NotificationPolicyContext {
  const timezone = opts.timezone ?? hostTimezone()
  const policyVersion = policyVersionFromInputs({
    quietHours: prefs.quietHours,
    minOsLevel: prefs.minOsLevel,
    minPushLevel: prefs.minPushLevel,
  })
  return {
    policyVersion,
    timezone,
    quietHoursEnabled: prefs.quietHours.enabled,
    quietHoursStart: prefs.quietHours.start,
    quietHoursEnd: prefs.quietHours.end,
    // Quiet hours evaluate in the user's local zone — no separate tz setting
    // on the V1 prefs, so the host zone is the evaluation zone.
    quietHoursTimezone: timezone,
    // Critical bypass is OFF by default — quiet hours hold even for `critical`
    // unless the operator opts in (the design's "critical bypass" is explicit).
    quietHoursAllowCritical: false,
    osThreshold: prefs.minOsLevel,
    pushThreshold: prefs.minPushLevel,
  }
}

/** A stable small-int version derived from the policy inputs. */
function policyVersionFromInputs(inputs: Record<string, unknown>): number {
  const hex = stableHash(inputs)
  // Fold the first 8 hex chars into a positive int — deterministic, and a
  // settings flip changes the hash (hence the version) without a counter.
  return parseInt(hex.slice(0, 8), 16) % 2147483647
}
