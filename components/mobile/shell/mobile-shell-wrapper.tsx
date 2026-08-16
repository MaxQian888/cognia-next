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

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { MobileConsentSheet } from "@/components/mobile/automation/mobile-consent-sheet"
import { FileViewerDialog } from "@/components/file-viewer/file-viewer-dialog"
import { OfflineBanner } from "@/components/mobile/offline-banner"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { usePlatform } from "@/hooks/use-platform"
import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"

import { MobileGlobalSearchHost } from "./mobile-global-search-host"
import { MobileTabBar, tabHref, type TabId } from "./mobile-tab-bar"
import { useMobileTabLayout } from "./use-mobile-tab-layout"

const TAB_BAR_HIDDEN_PREFIXES = ["/pair", "/oauth", "/onboarding"]

export interface MobileShellWrapperProps {
  children: React.ReactNode
  /** Optional unread/queued badges. Merged with the wrapper's auto-computed values. */
  badges?: Partial<Record<TabId, number>>
  className?: string
}

export function MobileShellWrapper({ children, badges, className }: MobileShellWrapperProps) {
  const platform = usePlatform()
  const pathname = usePathname() ?? "/"
  const router = useRouter()
  const lastInboxViewedAt = useSettingsStore((s) => s.settings?.lastInboxViewedAt ?? 0)
  const { resolved: resolvedTabs } = useMobileTabLayout()
  // Soft-keyboard state: while typing, the tab bar slides away and its
  // bottom reserve collapses so the composer sits directly on the keyboard
  // instead of floating a tab-bar height above it. No-op off mobile.
  const keyboard = useKeyboardInsets()

  // One-time launch redirect to the user's chosen landing tab. The wrapper is
  // mounted once in `app/layout.tsx` and persists across navigations, so the
  // first mount IS the app launch. We capture the launch path, then redirect
  // once settings resolve a non-chat landing — without hijacking later manual
  // taps onto the Chat tab.
  const launchPathRef = useRef<string | null>(null)
  if (launchPathRef.current === null) launchPathRef.current = pathname
  const landingDoneRef = useRef(false)
  // `loaded` flips true once the Dexie settings hydrate lands — the landing
  // decision must wait for it (the pre-hydration default is "chat").
  const settingsHydrated = useSettingsStore((s) => s.loaded)
  useEffect(() => {
    if (platform !== "mobile" || landingDoneRef.current) return
    if (launchPathRef.current !== "/") {
      landingDoneRef.current = true
      return
    }
    if (!settingsHydrated) return
    // Decision made exactly once per launch — even when it's "stay on chat".
    // Leaving the ref unset here meant a LATER settings edit (changing the
    // default landing on /me) re-fired this effect and ripped the user out
    // of whatever screen they were on.
    landingDoneRef.current = true
    if (resolvedTabs.defaultLanding !== "chat") {
      router.replace(tabHref(resolvedTabs.defaultLanding))
    }
  }, [platform, settingsHydrated, resolvedTabs.defaultLanding, router])

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
    // The terminal owns its safe-area accessory row and, on tablets, its
    // resizable project-workbench split. A second fixed tab bar would overlap
    // both the PTY and software keyboard.
    if (pathname === "/me/terminal") return false
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

  // Some routes own the full viewport and host an internal scroll region whose
  // `h-full` chain needs a *definite* parent height to resolve against:
  //   - Workflow detail sub-routes (`/workflows/...`): the touch editor + run
  //     detail host a fixed-height ReactFlow canvas.
  //   - The A2UI mini-apps hub + workspace (`/a2ui`): the hub wraps its body in
  //     a `ScrollArea h-full` and the workspace stacks header/toolbar over a
  //     flex-1 preview/tab region.
  //   - The first-run flow (`/onboarding`): `StepShell` is `h-full` so it can
  //     share one sizing rule with the desktop shell (where it fills the
  //     chrome's content slot); its rail, scroll body and sticky footer all
  //     hang off that height.
  // A bare `min-h-[100dvh]` is NOT a *definite* height, so those `h-full`
  // chains resolve to `auto` and collapse to 0 — the page renders as a blank
  // strip below the top bar. Give just those routes a definite flex-column
  // viewport so the offline banner takes its own row and the page body fills
  // the rest; every other (scrollable) route keeps the document-scroll
  // `min-h-[100dvh]`.
  const fullViewport =
    pathname.startsWith("/workflows/") ||
    pathname === "/a2ui" ||
    pathname.startsWith("/a2ui/") ||
    pathname === "/me/terminal" ||
    pathname === "/onboarding" ||
    pathname.startsWith("/onboarding/")

  return (
    <div
      data-testid="mobile-shell-wrapper"
      className={cn("contents", className)}
      data-platform={platform}
      data-tab-bar-visible={showTabBar ? "true" : "false"}
      data-full-viewport={fullViewport ? "true" : "false"}
      data-keyboard-visible={keyboard.isVisible ? "true" : "false"}
    >
      <div
        className={cn(
          fullViewport ? "flex h-[100dvh] flex-col overflow-hidden" : "min-h-[100dvh]",
          showTabBar && !keyboard.isVisible
            ? "pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]"
            : null
        )}
        // Keyboard-avoidance fallback. The primary path is Capacitor's
        // `Keyboard.resize: "native"` (the OS shrinks the WebView, overlap
        // stays 0 and this is a no-op). When the frame does NOT resize
        // (iOS ignoring `interactiveWidget`, plugin not registered), the
        // visualViewport overlap is > 0 and lifting the content by exactly
        // that amount keeps the composer / focused input above the keyboard.
        style={keyboard.keyboardHeight > 0 ? { paddingBottom: keyboard.keyboardHeight } : undefined}
      >
        <OfflineBanner />
        {children}
      </div>
      <MobileConsentSheet />
      {/* The mobile counterpart of the mount in `DesktopAppShell`, which this
          platform never reaches — that shell returns bare children here. It
          belongs at this level rather than in `AppShellMobile`: that component
          renders only on `/`, while the terminal at `/me/terminal` is one of
          the two places a file link is clicked. Self-gating on its own store,
          so an unopened viewer costs nothing. */}
      <FileViewerDialog />
      {/* Same reasoning for the unified global search (ADR-0129): ⌘K and the
          `command-palette-request` seam must answer on `/settings`, `/inbox`
          and `/me/*` too. The host renders nothing on `/`, where
          `AppShellMobile` mounts the picker-aware palette instead. */}
      <MobileGlobalSearchHost />
      {showTabBar ? <MobileTabBar badges={mergedBadges} keyboardHidden={keyboard.isVisible} /> : null}
    </div>
  )
}
