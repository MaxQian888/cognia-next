"use client"

/**
 * The app's attention count, pushed to the OS: the dock badge on macOS, the
 * launcher count on Linux desktops that honour it — and, in the web shell,
 * the tab title (`useWindowTitle`).
 *
 * The number is the sum of what the navigation already shows:
 *
 *   - unread conversations per guild (`useVisibleGuildUnread` — the shared
 *     `useGuildUnread` aggregate minus muted teams), which the rail badges on
 *     the DM and team buttons and which was computed as `total` but read by
 *     nothing;
 *   - the feature badges (`lib/shell/nav-badges.ts`): drafts and HITL cards
 *     waiting in the Inbox, paused runs, scheduler tasks that need a person,
 *     Bots that need setup.
 *
 * Every count behind it respects what the user switched off: hidden
 * navigation items stop reporting (their probes unmount), muted teams leave
 * the unread aggregate, and `showUnreadBadges: false` empties it. The badge
 * itself can be turned off in Settings → Notifications
 * (`notificationPreferences.appBadge`).
 *
 * Tauri 2 exposes `Window.setBadgeCount` (permission
 * `core:window:allow-set-badge-count`, granted to the main window in
 * `src-tauri/capabilities/default.json`). Windows has no count badge — the API
 * rejects there, which is logged once and not retried, so the title bar and
 * the rail stay the carriers of the number on that platform.
 */

import { useEffect, useMemo, useRef } from "react"
import { loggers } from "@cognia/logging"

import { useNavBadges } from "@/hooks/shell/use-nav-badges"
import { useVisibleGuildUnread } from "@/hooks/shell/use-team-mute"
import { resolvePreferences } from "@/lib/notifications/preferences"
import type { NavBadgeCounts } from "@/lib/shell/nav-badges"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { useSettingsStore } from "@/stores/settings"

const log = loggers.ui

/**
 * Guild unread plus every feature badge. The feature counts are summed whole:
 * only items that are on the navigation report one at all (see
 * `NavBadgeProbes`), so there is nothing hidden left in the snapshot to skip.
 */
export function computeAppAttentionCount(
  guildUnreadTotal: number,
  navBadges: NavBadgeCounts
): number {
  let total = Math.max(0, guildUnreadTotal)
  for (const count of Object.values(navBadges)) total += Math.max(0, count)
  return total
}

/** Whether the user wants the OS badge (default on). */
export function useAppBadgeEnabled(): boolean {
  const stored = useSettingsStore((s) => s.settings?.notificationPreferences)
  return resolvePreferences(stored).appBadge
}

/** The count the app badge and the tab title carry — `0` when switched off. */
export function useAppAttentionCount(): number {
  const unread = useVisibleGuildUnread()
  const badges = useNavBadges()
  const enabled = useAppBadgeEnabled()
  return useMemo(
    () => (enabled ? computeAppAttentionCount(unread.total, badges) : 0),
    [enabled, unread.total, badges]
  )
}

type BadgeWriter = (count: number | undefined) => Promise<void>

async function tauriBadgeWriter(): Promise<BadgeWriter> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const win = getCurrentWindow()
  // `undefined` clears the badge; `0` would draw a literal zero on some
  // launchers.
  return (count) => win.setBadgeCount(count)
}

/**
 * Push `count` to the OS badge of the main desktop window. No-op off Tauri and
 * in the auxiliary windows (pet, island, toolbar), which have neither a dock
 * tile of their own nor the permission. Clears the badge on unmount.
 */
export function useAppBadge(count: number): void {
  const unsupportedRef = useRef(false)
  const lastRef = useRef<number | null>(null)
  const active = isTauri() && isMainAppWindow()

  useEffect(() => {
    if (!active || unsupportedRef.current) return
    if (lastRef.current === count) return
    lastRef.current = count
    let cancelled = false
    void (async () => {
      try {
        const write = await tauriBadgeWriter()
        if (cancelled) return
        await write(count > 0 ? count : undefined)
      } catch (err) {
        // Windows (no count badge) and any platform without the capability
        // land here. Once is enough to know; the rail keeps the counts.
        unsupportedRef.current = true
        log.warn("app badge unsupported", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, count])

  useEffect(() => {
    if (!active) return
    return () => {
      if (unsupportedRef.current || !lastRef.current) return
      void tauriBadgeWriter()
        .then((write) => write(undefined))
        .catch(() => undefined)
    }
  }, [active])
}
