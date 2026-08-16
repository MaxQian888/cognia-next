"use client"

/**
 * Live layout facts about the shell's columns, as rendered.
 *
 * The title bar hosts each column's header (see
 * `components/shell/title-bar-outlets.tsx`), so its start / end zones have to
 * be exactly as wide as the conversation rail and the artifact dock beneath
 * them — including mid-animation, when the rail is sliding to zero and the
 * dock is snapping to a preset. Neither store that *owns* those widths says
 * what is on screen right now (`sidebarWidth` is the resting width, the dock's
 * `dockSize` is a percentage of a group whose width the bar cannot see), so
 * the columns report what they measure and the bar reads it here. The nav
 * rail reports too: it hides below `md` and while the sidebar hosts the
 * navigation, and the bar's outlets are offset by whatever it really draws.
 *
 * `sidebarHostsNav` is the one non-measurement here. The workspace sidebar
 * has two states — expanded (its top carries the shell navigation as rows)
 * and the 56px icon column (`GuildRail`). The expanded sidebar registers
 * itself while it is showing those rows; the shell reads the flag to hide the
 * icon column, so the same destinations are never on screen twice.
 *
 * Runtime-only, never persisted: measurements and mount state, not preferences.
 */

import { create } from "zustand"

export type ShellColumn = "rail" | "sidebar" | "dock"

export interface ShellColumnsState {
  /** Rendered border-box width per column, `0` while unmounted or collapsed. */
  widths: Record<ShellColumn, number>
  setColumnWidth: (column: ShellColumn, px: number) => void
  /** True while the expanded sidebar is rendering the shell navigation rows. */
  sidebarHostsNav: boolean
  /**
   * How many sidebars currently claim to host the navigation. A count, not a
   * flag: during a route transition (or an Offscreen / StrictMode remount) an
   * outgoing sidebar's cleanup can run *after* the incoming one registered,
   * and a plain boolean would then flash the icon column back for a frame.
   * `sidebarHostsNav` is `count > 0`.
   */
  sidebarNavHostCount: number
  /** Claim the navigation for a sidebar; returns the release. */
  registerSidebarNavHost: () => () => void
}

export const useShellColumnsStore = create<ShellColumnsState>()((set) => ({
  widths: { rail: 0, sidebar: 0, dock: 0 },
  setColumnWidth: (column, px) =>
    set((state) => {
      const next = Math.max(0, Math.round(px))
      if (state.widths[column] === next) return state
      return { widths: { ...state.widths, [column]: next } }
    }),
  sidebarHostsNav: false,
  sidebarNavHostCount: 0,
  registerSidebarNavHost: () => {
    let released = false
    set((state) => {
      const count = state.sidebarNavHostCount + 1
      return { sidebarNavHostCount: count, sidebarHostsNav: true }
    })
    return () => {
      // A release runs once, however many times React calls the cleanup.
      if (released) return
      released = true
      set((state) => {
        const count = Math.max(0, state.sidebarNavHostCount - 1)
        return { sidebarNavHostCount: count, sidebarHostsNav: count > 0 }
      })
    }
  },
}))
