"use client"

/**
 * Register the expanded sidebar as the shell navigation's host while `active`.
 *
 * The workspace sidebar shows the shell navigation as labelled rows at its
 * top; the 56px icon column (`GuildRail`) shows the same destinations when the
 * sidebar is collapsed or absent. `DesktopAppShell` reads
 * `useShellColumnsStore.sidebarHostsNav` to decide which of the two is on
 * screen. The sidebar — the only component that knows whether it is really
 * rendering those rows (desktop branch, not collapsed, a chat guild rather
 * than a plugin view) — calls this with that condition; the claim is released
 * on unmount and whenever the condition drops.
 *
 * A layout effect, deliberately: the sidebar commits its collapse / expand
 * width in a layout effect too (`channel-list.tsx`), and a passive effect here
 * would let the browser paint one frame with the rail at 0 *and* the icon
 * column still hidden (collapse), or both columns on screen (expand).
 */

import { useLayoutEffect } from "react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"

export function useSidebarNavHost(active: boolean): void {
  const registerSidebarNavHost = useShellColumnsStore((s) => s.registerSidebarNavHost)
  useLayoutEffect(() => {
    if (!active) return
    return registerSidebarNavHost()
  }, [active, registerSidebarNavHost])
}
