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
 * `src-tauri/capabilities/default.json`) for macOS and Linux. Windows has no
 * count badge, so there the number is drawn as the taskbar button's overlay
 * icon instead (`Window.setOverlayIcon` with an `Image` built from the pixels
 * `lib/shell/taskbar-badge.ts` renders; permission
 * `core:window:allow-set-overlay-icon`, and `core:image:allow-new` through
 * `core:default`). The overlay's colours are read from the theme tokens at
 * each write. A platform where neither works is logged once and not retried;
 * the title bar and the rail keep the number there.
 */

import { useEffect, useMemo, useRef } from "react"
import { loggers } from "@cognia/logging"
import type { Window as TauriWindow } from "@tauri-apps/api/window"

import { useNavBadges } from "@/hooks/shell/use-nav-badges"
import { useVisibleGuildUnread } from "@/hooks/shell/use-team-mute"
import { resolvePreferences } from "@/lib/notifications/preferences"
import { detectDesktopOsFamily } from "@/lib/platform/os"
import { badgeIconSize, readBadgeColors, renderTaskbarBadge } from "@/lib/shell/taskbar-badge"
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

/**
 * Windows: paint the count as the taskbar overlay icon. The `Image` is a
 * resource handle on the Rust side; it is released once the overlay holds
 * its own copy.
 */
function overlayBadgeWriter(win: TauriWindow): BadgeWriter {
  return async (count) => {
    if (count === undefined) {
      await win.setOverlayIcon(undefined)
      return
    }
    const { Image } = await import("@tauri-apps/api/image")
    const pixels = renderTaskbarBadge(count, {
      size: badgeIconSize(typeof window === "undefined" ? 1 : window.devicePixelRatio),
      colors: readBadgeColors(),
    })
    const image = await Image.new(pixels.rgba, pixels.width, pixels.height)
    try {
      await win.setOverlayIcon(image)
    } finally {
      await image.close().catch(() => undefined)
    }
  }
}

async function tauriBadgeWriter(): Promise<BadgeWriter> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const win = getCurrentWindow()
  if (detectDesktopOsFamily() === "windows") return overlayBadgeWriter(win)
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
  // Resolved once, by the first write, and reused by the unmount clear: that
  // cleanup also runs when Fast Refresh swaps this module out, and importing
  // `@tauri-apps/api/window` from a module HMR has already disposed fails
  // ("Unexpected import of module … deleted by an HMR update").
  const writerRef = useRef<Promise<BadgeWriter> | null>(null)
  const active = isTauri() && isMainAppWindow()

  useEffect(() => {
    if (!active || unsupportedRef.current) return
    if (lastRef.current === count) return
    lastRef.current = count
    let cancelled = false
    void (async () => {
      try {
        writerRef.current ??= tauriBadgeWriter()
        const write = await writerRef.current
        if (cancelled) return
        await write(count > 0 ? count : undefined)
      } catch (err) {
        // A platform with neither a count badge nor an overlay icon, or a
        // window without the capability, lands here. Once is enough to know;
        // the rail keeps the counts.
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
      // Nothing to clear until a write has resolved the writer.
      const writer = writerRef.current
      if (unsupportedRef.current || !lastRef.current || !writer) return
      void writer.then((write) => write(undefined)).catch(() => undefined)
    }
  }, [active])
}
