"use client"

/**
 * Wires the chat row's width budget (`lib/shell/chat-row-budget.ts`, ADR-0214
 * D5) to the live layout: measures the row, resolves the budget, and folds or
 * releases the conversation sidebar through the ui-store's transient fold.
 *
 * The dock host owns what the budget says about the dock itself (the overlay);
 * the sidebar is a different column with its own owner, so the fold goes
 * through the store rather than through a prop.
 */

import { useEffect, useMemo } from "react"

import { useElementAxisSize } from "@/hooks/use-element-axis-size"
import {
  resolveChatRowBudget,
  type ChatRowBudget,
  type ChatRowDockFloor,
  type ChatRowSidebarState,
} from "@/lib/shell/chat-row-budget"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_SIDEBAR_SIDE, GUILD_RAIL_WIDTH_PX } from "@/types/shell/sidebar"

export interface ChatRowBudgetOptions {
  /**
   * The element holding the conversation sidebar and the dock host side by
   * side — the dock host's parent in the chat workspace. `null` (or a 0-wide
   * element, as in jsdom) holds the current layout.
   */
  row: HTMLElement | null
  dockOpen: boolean
  dockFloor: ChatRowDockFloor
  chatMinPx: number
}

export function useChatRowBudget({
  row,
  dockOpen,
  dockFloor,
  chatMinPx,
}: ChatRowBudgetOptions): ChatRowBudget | null {
  const rowPx = useElementAxisSize(row, "width")
  // The icon rail sits outside the row, and appears exactly as the sidebar
  // folds. Adding it back keeps the total the fold only redistributes.
  const railPx = useShellColumnsStore((state) => state.widths.rail)
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const sidebarAutoCollapsed = useUIStore((state) => state.sidebarAutoCollapsed)
  const foldAllowed = useUIStore((state) => !state.sidebarAutoCollapseSuppressed)
  const sidebarWidth = useUIStore((state) => state.sidebarWidth)
  const guildRailCollapsed = useUIStore((state) => state.guildRailCollapsed)
  const sidebarSide = useSettingsStore(
    (state) => state.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE
  )

  const sidebar: ChatRowSidebarState = sidebarAutoCollapsed
    ? "auto-folded"
    : sidebarCollapsed
      ? "user-folded"
      : "expanded"
  // Folded, the sidebar leaves the icon rail (unless the user hid that too).
  // Open on the left it hosts the navigation itself and the rail steps aside;
  // on the right the rail stays beside it (`channel-list.tsx`, `merged`).
  const foldedSidebarPx = guildRailCollapsed ? 0 : GUILD_RAIL_WIDTH_PX
  const expandedSidebarPx = sidebarWidth + (sidebarSide === "left" ? 0 : foldedSidebarPx)
  const { minPx: floorMinPx, minPercent: floorMinPercent } = dockFloor

  const budget = useMemo(
    () =>
      resolveChatRowBudget({
        totalPx: rowPx > 0 ? rowPx + railPx : 0,
        sidebar,
        expandedSidebarPx,
        foldedSidebarPx,
        foldAllowed,
        dockOpen,
        dockFloor: { minPx: floorMinPx, minPercent: floorMinPercent },
        chatMinPx,
      }),
    [
      rowPx,
      railPx,
      sidebar,
      expandedSidebarPx,
      foldedSidebarPx,
      foldAllowed,
      dockOpen,
      floorMinPx,
      floorMinPercent,
      chatMinPx,
    ]
  )

  const measured = budget !== null
  const autoFold = budget?.autoFold ?? false
  const needsFold = budget?.needsFold ?? false
  useEffect(() => {
    if (!measured) return
    const ui = useUIStore.getState()
    if (autoFold) ui.autoCollapseSidebar()
    // `needsFold` without `autoFold`: the user refused the fold — hold it.
    else if (!needsFold) ui.releaseSidebarAutoCollapse()
  }, [measured, autoFold, needsFold])

  // A fold borrowed for this row is returned with it — leaving the chat route,
  // or the window dropping to the tablet Sheet, takes the reason with it.
  useEffect(() => () => useUIStore.getState().releaseSidebarAutoCollapse(), [])

  return budget
}
