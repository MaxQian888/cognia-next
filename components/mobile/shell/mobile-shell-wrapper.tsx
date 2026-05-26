"use client"

/**
 * Mobile Shell wrapper (Wave 2.2).
 *
 * Wraps the app's main content in a mobile-friendly container that:
 *   - Reserves bottom safe-area + tab-bar height so children don't get
 *     hidden under the fixed `<MobileTabBar />`.
 *   - Hides the tab bar on routes where it would conflict with the page's
 *     own chrome (pair flow, fullscreen workflow viewer).
 *   - Mounts the `<MobileTabBar />` only when the active platform is
 *     `mobile` — desktop / web pass children through unchanged.
 *   - Computes an "Inbox unread" badge over the Chat tab from the
 *     `inboundLedger` count newer than `settings.lastInboxViewedAt`.
 *
 * Mounted from `app/layout.tsx` between `CompanionBootProvider` and the
 * routed children.
 */

import { usePathname } from "next/navigation"
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { MobileConsentSheet } from "@/components/mobile/automation/mobile-consent-sheet"
import { MobileOutboundRunnerProvider } from "@/components/mobile/mobile-outbound-runner-provider"
import { OfflineBanner } from "@/components/mobile/offline-banner"
import { usePlatform } from "@/hooks/use-platform"
import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"

import { MobileTabBar, type TabId } from "./mobile-tab-bar"

const TAB_BAR_HIDDEN_PREFIXES = ["/pair", "/oauth"]

export interface MobileShellWrapperProps {
  children: React.ReactNode
  /** Optional unread/queued badges. Merged with the wrapper's auto-computed values. */
  badges?: Partial<Record<TabId, number>>
  className?: string
}

export function MobileShellWrapper({ children, badges, className }: MobileShellWrapperProps) {
  const platform = usePlatform()
  const pathname = usePathname() ?? "/"
  const lastInboxViewedAt = useSettingsStore((s) => s.settings?.lastInboxViewedAt ?? 0)

  const inboundUnread =
    useLiveQuery<number>(
      () => getDb().inboundLedger.where("receivedAt").above(lastInboxViewedAt).count(),
      [lastInboxViewedAt]
    ) ?? 0

  const showTabBar = useMemo(() => {
    if (platform !== "mobile") return false
    // Workflow detail sub-routes (the full-screen touch editor + run detail)
    // own the whole viewport — hide the tab bar so it doesn't fight the
    // canvas FAB / inspector drawer. The `/workflows` list itself keeps it.
    if (pathname.startsWith("/workflows/")) return false
    return !TAB_BAR_HIDDEN_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
    )
  }, [platform, pathname])

  // Desktop pass-through: skip mobile-only providers (OfflineBanner,
  // outbound runner, tab bar) and the `min-h-[100dvh]` viewport reservation
  // so `DesktopAppShell` owns the entire layout. The thin wrapper div is
  // kept so existing tests / dev tools can still locate the shell.
  if (platform !== "mobile") {
    return (
      <div
        data-testid="mobile-shell-wrapper"
        className={cn("contents", className)}
        data-platform={platform}
        data-tab-bar-visible="false"
      >
        {children}
      </div>
    )
  }

  const mergedBadges: Partial<Record<TabId, number>> = {
    ...(badges ?? {}),
    chat: (badges?.chat ?? 0) + inboundUnread,
  }

  return (
    <div
      data-testid="mobile-shell-wrapper"
      className={cn("contents", className)}
      data-platform={platform}
      data-tab-bar-visible={showTabBar ? "true" : "false"}
    >
      <div
        className={cn(
          "min-h-[100dvh]",
          showTabBar ? "pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]" : null
        )}
      >
        <OfflineBanner />
        {children}
      </div>
      <MobileOutboundRunnerProvider />
      <MobileConsentSheet />
      {showTabBar ? <MobileTabBar badges={mergedBadges} /> : null}
    </div>
  )
}
