"use client"

/**
 * Paint the native status and navigation bars to match the account gate.
 *
 * `CompanionBootProvider` owns the bars once the app is open, but it lives
 * inside the gate: while the profile is locked it is not mounted, so the bars
 * kept whatever the launch screen or the last session left on them, a grey
 * strip over a lock screen of a different colour. The gate screens read the
 * colours the page is actually painting (the boot script has replayed the
 * mirrored palette by then), so the chrome and the page are one surface.
 *
 * Mobile only, and a no-op until next-themes has resolved the variant.
 */

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { readAccountTheme } from "@/lib/appearance/lock-screen-preferences"

import { readPaintedShellColors } from "@/lib/appearance/shell-sync"
import { isMobile } from "@/lib/capacitor/_shared"
import { syncWithTheme as syncNavBar } from "@/lib/capacitor/navigation-bar"
import { registerNativePlugins } from "@/lib/capacitor/register-plugins"
import { syncWithTheme as syncStatusBar } from "@/lib/capacitor/status-bar"

/** Restore the selected account's mode before its database can be opened. */
export function useLockedAccountTheme(accountId: string | null): void {
  const { theme, setTheme } = useTheme()
  const savedTheme = readAccountTheme(accountId)
  useIsomorphicLayoutEffect(() => {
    if (savedTheme && savedTheme !== theme) setTheme(savedTheme)
  }, [savedTheme, theme, setTheme])
}

export function useLockedShellChrome(): void {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!resolvedTheme || !isMobile()) return
    let cancelled = false
    // The plugin proxies may not exist yet on a cold boot straight into the
    // lock screen; registration is idempotent, and waiting for it is what
    // keeps the first paint from no-opping as `unsupported`.
    void registerNativePlugins().then(() => {
      if (cancelled) return
      const { backgroundHex } = readPaintedShellColors(resolvedTheme)
      void syncStatusBar(resolvedTheme, backgroundHex)
      void syncNavBar(resolvedTheme, backgroundHex)
    })
    return () => {
      cancelled = true
    }
  }, [resolvedTheme])
}
