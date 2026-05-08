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
 *
 * Mounted from `app/layout.tsx` between `CompanionBootProvider` and the
 * routed children.
 */

import { usePathname } from "next/navigation"
import { useMemo } from "react"

import { OfflineBanner } from "@/components/mobile/offline-banner"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"

import { MobileTabBar, type TabId } from "./mobile-tab-bar"

const TAB_BAR_HIDDEN_PREFIXES = ["/pair", "/oauth"]

export interface MobileShellWrapperProps {
  children: React.ReactNode
  /** Optional unread/queued badges. */
  badges?: Partial<Record<TabId, number>>
  className?: string
}

export function MobileShellWrapper({ children, badges, className }: MobileShellWrapperProps) {
  const platform = usePlatform()
  const pathname = usePathname() ?? "/"

  const showTabBar = useMemo(() => {
    if (platform !== "mobile") return false
    return !TAB_BAR_HIDDEN_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
    )
  }, [platform, pathname])

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
      {showTabBar ? <MobileTabBar badges={badges} /> : null}
    </div>
  )
}
