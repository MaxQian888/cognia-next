/**
 * How the desktop chat row shares its width between the conversation sidebar,
 * the chat and the dock (ADR-0214, D5).
 *
 * The dock keeps the chat at `CHAT_MIN_PX` by capping its own width, but the
 * dock has a floor too (480px for the workspace profile, 24% for artifacts),
 * and nothing reconciled the two: on a window narrower than both together the
 * panel library was handed a floor above its cap. This decides, in order:
 *
 *   1. the dock shrinks toward its floor while the chat keeps its minimum
 *      (the dock's existing cap does the shrinking — this only checks it fits);
 *   2. the sidebar folds to its icon rail, as a transient override that never
 *      touches the user's persisted preference;
 *   3. the dock leaves the row and floats over the chat with a scrim.
 *
 * Pure, so the thresholds are one table test away. The inputs are chosen to be
 * invariant under the decision itself: `totalPx` is the sidebar, the chat, the
 * dock and the icon rail together, which folding the sidebar only redistributes.
 * Deciding from the chat + dock width alone would read the fold's own animation
 * as a change in the window and flip back mid-gesture.
 */

/**
 * Extra room an auto-folded sidebar needs before it unfolds. The live total is
 * measured from two columns that animate on the same clock but report through
 * separate observers, so it can be a few pixels off mid-gesture; a fold that
 * released on exactly the threshold that triggered it would flicker there.
 */
export const CHAT_ROW_BUDGET_HYSTERESIS_PX = 24

/** Where the sidebar is: open, folded by this budget, or folded by the user. */
export type ChatRowSidebarState = "expanded" | "auto-folded" | "user-folded"

/** The dock's narrowest width: an absolute floor, a share of the row, or both. */
export interface ChatRowDockFloor {
  minPx: number
  minPercent: number
}

export interface ChatRowBudgetInput {
  /** Sidebar + chat + dock + icon rail, as rendered. `0` while unmeasured. */
  totalPx: number
  sidebar: ChatRowSidebarState
  /** What the open sidebar takes: its width plus any icon rail beside it. */
  expandedSidebarPx: number
  /** What the folded sidebar leaves behind: the icon rail, or nothing. */
  foldedSidebarPx: number
  /** False once the user re-opened an auto-folded sidebar this session. */
  foldAllowed: boolean
  dockOpen: boolean
  dockFloor: ChatRowDockFloor
  chatMinPx: number
}

export interface ChatRowBudget {
  /** The sidebar should be folded by the budget (never set for a user fold). */
  autoFold: boolean
  /**
   * The open sidebar leaves the chat too little room. Distinct from
   * `autoFold`: when the user has refused the fold this stays true while
   * `autoFold` is false, and the budget moves on to the overlay instead.
   */
  needsFold: boolean
  /** The dock floats over the chat instead of taking a column. */
  overlay: boolean
  /** Width the chat and an in-row dock share once this is applied. */
  groupPx: number
}

export function dockFloorPx(floor: ChatRowDockFloor, groupPx: number): number {
  return Math.max(floor.minPx, (floor.minPercent / 100) * groupPx)
}

function fits(groupPx: number, input: ChatRowBudgetInput, slackPx: number): boolean {
  return groupPx - dockFloorPx(input.dockFloor, groupPx) >= input.chatMinPx + slackPx
}

/** `null` while the row is unmeasured: hold whatever is applied now. */
export function resolveChatRowBudget(input: ChatRowBudgetInput): ChatRowBudget | null {
  if (!Number.isFinite(input.totalPx) || input.totalPx <= 0) return null
  const expandedGroup = input.totalPx - input.expandedSidebarPx
  const foldedGroup = input.totalPx - input.foldedSidebarPx

  if (input.sidebar === "user-folded") {
    return {
      autoFold: false,
      needsFold: false,
      overlay: input.dockOpen && !fits(foldedGroup, input, 0),
      groupPx: foldedGroup,
    }
  }

  // A closed dock claims no column, so nothing has to give way for it — and a
  // fold made for the dock is released with it.
  if (!input.dockOpen) {
    return { autoFold: false, needsFold: false, overlay: false, groupPx: expandedGroup }
  }

  const needsFold =
    input.sidebar === "auto-folded"
      ? !fits(expandedGroup, input, CHAT_ROW_BUDGET_HYSTERESIS_PX)
      : !fits(expandedGroup, input, 0)
  const autoFold = needsFold && input.foldAllowed
  const groupPx = autoFold ? foldedGroup : expandedGroup
  return {
    autoFold,
    needsFold,
    overlay: needsFold && !fits(groupPx, input, 0),
    groupPx,
  }
}

/**
 * The overlaid dock's width: what it would have in the row, never under its
 * floor, and always leaving a strip of the conversation in view so the scrim
 * reads as "on top of the chat" rather than as a page of its own.
 */
export const DOCK_OVERLAY_CHAT_PEEK_PX = 48

export function dockOverlayWidthPx(
  groupPx: number,
  preferredPercent: number,
  floor: ChatRowDockFloor
): number {
  const room = Math.max(0, groupPx - DOCK_OVERLAY_CHAT_PEEK_PX)
  const preferred = Math.max(dockFloorPx(floor, groupPx), (preferredPercent / 100) * groupPx)
  return Math.round(Math.min(room, preferred))
}
