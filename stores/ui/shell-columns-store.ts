"use client"

/**
 * Live pixel widths of the chat workspace's side columns, as rendered.
 *
 * The title bar hosts each column's header (see
 * `components/shell/title-bar-outlets.tsx`), so its start / end zones have to
 * be exactly as wide as the conversation rail and the artifact dock beneath
 * them — including mid-animation, when the rail is sliding to zero and the
 * dock is snapping to a preset. Neither store that *owns* those widths says
 * what is on screen right now (`sidebarWidth` is the resting width, the dock's
 * `dockSize` is a percentage of a group whose width the bar cannot see), so
 * the columns report what they measure and the bar reads it here.
 *
 * Runtime-only, never persisted: it is a measurement, not a preference.
 */

import { create } from "zustand"

export type ShellColumn = "sidebar" | "dock"

export interface ShellColumnsState {
  /** Rendered border-box width per column, `0` while unmounted or collapsed. */
  widths: Record<ShellColumn, number>
  setColumnWidth: (column: ShellColumn, px: number) => void
}

export const useShellColumnsStore = create<ShellColumnsState>()((set) => ({
  widths: { sidebar: 0, dock: 0 },
  setColumnWidth: (column, px) =>
    set((state) => {
      const next = Math.max(0, Math.round(px))
      if (state.widths[column] === next) return state
      return { widths: { ...state.widths, [column]: next } }
    }),
}))
