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
 * than a plugin view) — calls this with that condition; the flag clears on
 * unmount and whenever the condition drops.
 */

import { useEffect } from "react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"

export function useSidebarNavHost(active: boolean): void {
  const setSidebarHostsNav = useShellColumnsStore((s) => s.setSidebarHostsNav)
  useEffect(() => {
    if (!active) return
    setSidebarHostsNav(true)
    return () => setSidebarHostsNav(false)
  }, [active, setSidebarHostsNav])
}
