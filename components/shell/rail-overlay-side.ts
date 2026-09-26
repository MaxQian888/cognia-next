"use client"

/**
 * Which way the navigation's overlays open — tooltips, popovers, the More
 * menu. Always inward: a rail on the left edge opens rightward, one on the
 * right edge opens leftward, or they open off-screen.
 *
 * A context rather than a prop: the rail has a dozen overlay owners (every
 * `RailButton`, the workspace switcher, the More popover), and a missed prop
 * is invisible until a tooltip opens past the window edge. The expanded
 * sidebar provides it too, because it follows the same `sidebarSide`.
 *
 * Defaults to the left rail's behaviour, so a control rendered outside a
 * provider (tests, stories) keeps opening rightward.
 */

import { createContext, useContext } from "react"

import type { SidebarSide } from "@/types/shell/sidebar"

export type OverlaySide = "left" | "right"

export const OverlaySideContext = createContext<OverlaySide>("right")

export function useOverlaySide(): OverlaySide {
  return useContext(OverlaySideContext)
}

/** The inward direction for a column docked on `edge`. */
export function overlaySideFor(edge: SidebarSide): OverlaySide {
  return edge === "right" ? "left" : "right"
}
