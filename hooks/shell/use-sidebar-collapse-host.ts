"use client"

/**
 * Register the expanded sidebar's footer as the home of the collapse button
 * while `active`.
 *
 * The chat header draws the conversation-list toggle when nothing else does.
 * Once the footer carries the collapse button, the header keeps only the
 * expand half — the footer leaves with the rail, so expanding again still
 * needs a control outside it. `useShellColumnsStore.sidebarHostsCollapse` is
 * what the header reads; the claim is released on unmount and whenever
 * `active` drops.
 *
 * A layout effect, like `useSidebarNavHost`: a passive one would paint a
 * frame with both buttons (expand) or with neither (the header's coming back).
 */

import { useLayoutEffect } from "react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"

export function useSidebarCollapseHost(active: boolean): void {
  const register = useShellColumnsStore((s) => s.registerSidebarCollapseHost)
  useLayoutEffect(() => {
    if (!active) return
    return register()
  }, [active, register])
}
