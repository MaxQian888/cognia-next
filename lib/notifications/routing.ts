// Channel routing (ADR-0042). Pure: given an input, resolved preferences, and
// the current time, decide which fan-out channels fire. `center` is always
// kept (durable record). `critical` bypasses per-source mute, level gates, and
// DND (Novu `readOnly` semantics). DND reuses `isInQuietHours` from the
// connector outbound-runner (the project's quiet-hours evaluator).

import {
  NOTIFICATION_LEVEL_RANK,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationPreferences,
  type NotificationSource,
} from "@/types/notifications"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import { resolveSourcePref } from "./preferences"

const CHANNEL_ORDER: NotificationChannel[] = ["center", "toast", "os", "push", "im"]

function ordered(set: Set<NotificationChannel>): NotificationChannel[] {
  return CHANNEL_ORDER.filter((c) => set.has(c))
}

export interface RoutingInput {
  source: NotificationSource
  level: NotificationLevel
  channels?: NotificationChannel[]
}

export interface RoutingDecision {
  channels: NotificationChannel[]
  suppressedByDnd: boolean
}

/** Resolve the local IANA timezone (injectable for deterministic tests). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function resolveChannels(
  input: RoutingInput,
  prefs: NotificationPreferences,
  now: number,
  tz: string = localTimeZone()
): RoutingDecision {
  const critical = input.level === "critical"
  const sourcePref = resolveSourcePref(prefs, input.source)

  // Base channel set: a caller-supplied `channels` is authoritative (it knows
  // what it wants, e.g. a scheduler task configured for desktop), otherwise the
  // per-source override, else the global default. Either way `center` survives
  // and the level gates / mute / DND below still apply.
  const channels = new Set<NotificationChannel>(
    input.channels ?? sourcePref.channels ?? prefs.globalDefaultChannels
  )
  channels.add("center")

  // Critical forces toast + OS through, ignoring mute / gates / DND.
  if (critical) {
    channels.add("toast")
    channels.add("os")
    return { channels: ordered(channels), suppressedByDnd: false }
  }

  // Muted source → center only.
  if (sourcePref.enabled === false) {
    return { channels: ["center"], suppressedByDnd: false }
  }

  // Level gates for OS / push.
  const rank = NOTIFICATION_LEVEL_RANK[input.level]
  if (rank < NOTIFICATION_LEVEL_RANK[sourcePref.minOsLevel ?? prefs.minOsLevel]) {
    channels.delete("os")
  }
  if (rank < NOTIFICATION_LEVEL_RANK[prefs.minPushLevel]) {
    channels.delete("push")
  }

  // Do-Not-Disturb (quiet hours) — strip interruptive channels, keep center.
  let suppressedByDnd = false
  if (
    prefs.quietHours.enabled &&
    isInQuietHours(now, prefs.quietHours.start, prefs.quietHours.end, tz)
  ) {
    suppressedByDnd = true
    channels.delete("toast")
    channels.delete("os")
    channels.delete("push")
    // `im` is interruptive (pushes to the user's phone via the IM platform), so
    // DND strips it too. Critical already returned above, so critical IM pushes
    // still go through.
    channels.delete("im")
  }

  return { channels: ordered(channels), suppressedByDnd }
}
