// Notification preferences resolution (ADR-0042). Pure functions: merge the
// user's stored partial onto `DEFAULT_NOTIFICATION_PREFERENCES`, and resolve
// the effective per-source override. Preferences live on the AppSettings
// singleton (`notificationPreferences`) — same JSON pattern as `goalConsoleView`.

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type NotificationSource,
  type NotificationSourcePref,
} from "@/types/notifications"

/** Merge a stored partial over the defaults (deep for nested objects). */
export function resolvePreferences(
  stored?: Partial<NotificationPreferences> | null
): NotificationPreferences {
  if (!stored) return DEFAULT_NOTIFICATION_PREFERENCES
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...stored,
    quietHours: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours,
      ...(stored.quietHours ?? {}),
    },
    perSource: { ...(stored.perSource ?? {}) },
    globalDefaultChannels:
      stored.globalDefaultChannels ?? DEFAULT_NOTIFICATION_PREFERENCES.globalDefaultChannels,
  }
}

/** Effective override for a source — defaults to enabled with no overrides. */
export function resolveSourcePref(
  prefs: NotificationPreferences,
  source: NotificationSource
): NotificationSourcePref {
  return prefs.perSource[source] ?? { enabled: true }
}
