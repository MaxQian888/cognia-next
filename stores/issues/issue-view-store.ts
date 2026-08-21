/**
 * Issue View Store — persisted per-view display preferences for `/issues`.
 *
 * Before this existed every one of these lived in `useState` inside
 * `IssueConsole`, so switching route and coming back reset the board to the
 * `all` view with no filter, board layout and comfortable density — every
 * time. Nothing about a filter or a collapsed column is session-scoped.
 *
 * Overrides are stored PER VIEW and PARTIALLY: a key that isn't here means
 * "no opinion", and `resolveIssueViewPreferences` falls back to whatever the
 * `IssueViewDefinition` declares. That matters because the four built-ins
 * declare different defaults (`created` opens as a list, `my-agents` groups by
 * assignee) — a single global override set would fight them on every switch.
 * It also means `resetView` is a delete, not a re-derivation.
 *
 * Panel split widths deliberately do NOT live here; those belong to
 * `hooks/ui/use-resizable-layout.ts`, which is what every other feature shell
 * in the repo uses and which speaks react-resizable-panels' own format.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import {
  DEFAULT_ISSUE_VIEW_ID,
  EMPTY_COLUMN_COLLAPSE,
  resolveColumnCollapsed,
  toggleColumnCollapse,
  type IssueListDensity,
  type IssueSortMode,
  type IssueViewLayout,
  type IssueViewPreferences,
} from "@/lib/issues/views"
import type { IssueBoardFilter, IssueGroupBy } from "@/lib/issues/board-model"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { IssueStatus } from "@/types/issues"

/** Stored overrides for one view id. Absent keys fall back to the definition. */
export type IssueViewOverrides = Partial<IssueViewPreferences>

export interface IssueViewState {
  /** Which built-in view is active. */
  viewId: string
  /** Left rail folded to nothing. */
  railCollapsed: boolean
  /** viewId → the user's overrides for that view. */
  overrides: Record<string, IssueViewOverrides>

  setViewId: (viewId: string) => void
  setRailCollapsed: (collapsed: boolean) => void

  setFilter: (viewId: string, filter: IssueBoardFilter) => void
  setSort: (viewId: string, sort: IssueSortMode) => void
  setGroupBy: (viewId: string, groupBy: IssueGroupBy) => void
  setLayout: (viewId: string, layout: IssueViewLayout) => void
  setDensity: (viewId: string, density: IssueListDensity) => void
  /**
   * Flip one board column between full column and vertical strip.
   *
   * `itemCount` is required because the derived default is "collapse iff
   * empty" — without it the store would flip against an absent-key default
   * rather than against what the user can actually see.
   */
  toggleColumnCollapsed: (viewId: string, status: IssueStatus, itemCount: number) => void

  /** Drop every override for a view, returning it to its declared defaults. */
  resetView: (viewId: string) => void
  /** Wipe everything — used by tests and the "reset layout" affordance. */
  reset: () => void
}

const INITIAL: Pick<IssueViewState, "viewId" | "railCollapsed" | "overrides"> = {
  viewId: DEFAULT_ISSUE_VIEW_ID,
  railCollapsed: false,
  overrides: {},
}

export const useIssueViewStore = create<IssueViewState>()(
  persist(
    (set, get) => {
      /**
       * Merge one key into a view's overrides. Written once here rather than
       * six times so a future key cannot forget to preserve its siblings.
       */
      const patch = (viewId: string, next: IssueViewOverrides) => {
        set((state) => ({
          overrides: {
            ...state.overrides,
            [viewId]: { ...state.overrides[viewId], ...next },
          },
        }))
      }

      return {
        ...INITIAL,

        setViewId: (viewId) => set({ viewId }),
        setRailCollapsed: (railCollapsed) => set({ railCollapsed }),

        setFilter: (viewId, filter) => patch(viewId, { filter }),
        setSort: (viewId, sort) => patch(viewId, { sort }),
        setGroupBy: (viewId, groupBy) => patch(viewId, { groupBy }),
        setLayout: (viewId, layout) => patch(viewId, { layout }),
        setDensity: (viewId, density) => patch(viewId, { density }),

        toggleColumnCollapsed: (viewId, status, itemCount) => {
          const current = get().overrides[viewId]?.columnCollapse ?? EMPTY_COLUMN_COLLAPSE
          patch(viewId, {
            columnCollapse: toggleColumnCollapse(
              current,
              status,
              resolveColumnCollapsed(status, itemCount, current)
            ),
          })
        },

        resetView: (viewId) => {
          set((state) => {
            if (!(viewId in state.overrides)) return state
            const next = { ...state.overrides }
            delete next[viewId]
            return { overrides: next }
          })
        },

        reset: () => set({ ...INITIAL, overrides: {} }),
      }
    },
    {
      name: "cognia-issue-view",
      storage: persistLocalStorage(),
      version: 1,
      partialize: (state) => ({
        viewId: state.viewId,
        railCollapsed: state.railCollapsed,
        overrides: state.overrides,
      }),
    }
  )
)

export default useIssueViewStore
