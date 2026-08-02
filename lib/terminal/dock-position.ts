/**
 * Pure helpers for moving the terminal dock between its two edges.
 *
 * Kept out of the React components so the drop resolution — the part that is
 * easy to get subtly wrong — is testable without simulating a dnd-kit drag,
 * which jsdom cannot do.
 */

import type { TerminalPanelPosition } from "@/stores/terminal/terminal-store"

/** dnd-kit draggable id for the dock's move grip. */
export const TERMINAL_DOCK_DRAG_ID = "terminal-dock"

/** dnd-kit droppable ids for the two edges the dock can land on. */
export const TERMINAL_DOCK_DROP_IDS = {
  bottom: "terminal-dock-drop-bottom",
  right: "terminal-dock-drop-right",
} as const

const DROP_ID_TO_POSITION = new Map<string, TerminalPanelPosition>([
  [TERMINAL_DOCK_DROP_IDS.bottom, "bottom"],
  [TERMINAL_DOCK_DROP_IDS.right, "right"],
])

/**
 * Resolve a drag end into the dock's next position.
 *
 * Returns `null` — meaning "leave it alone" — when the pointer was released
 * outside any drop zone, over an unrelated droppable, or over the zone the dock
 * already occupies. Treating a no-op drop as a position change would clear
 * `maximized` and re-run the slide animation for nothing.
 */
export function resolveDropPosition(
  overId: string | null | undefined,
  current: TerminalPanelPosition
): TerminalPanelPosition | null {
  if (!overId) return null
  const next = DROP_ID_TO_POSITION.get(overId)
  if (!next || next === current) return null
  return next
}

/**
 * The other edge. Backs the keyboard fallback on the grip and the toolbar /
 * menu toggle — dnd-kit's keyboard sensor is unusable over free-floating
 * droppables, so the grip must offer a non-pointer path of its own.
 */
export function nextDockPosition(current: TerminalPanelPosition): TerminalPanelPosition {
  return current === "bottom" ? "right" : "bottom"
}
