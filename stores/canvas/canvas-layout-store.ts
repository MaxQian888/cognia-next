/**
 * Canvas Layout Store — persisted shell sizing for the Canvas guild.
 *
 * Owns: panel sizes (percent), per-rail collapsed flags, the active
 * right-rail tab, the set of OPEN documents (the tab strip), and runtime-only
 * mobile sheet open flags. The `<CanvasShell />` component calls `setSizes` on
 * every drag tick; persistence is debounced internally so localStorage isn't
 * thrashed.
 *
 * `openDocIds` is why closing a tab is no longer a delete. Canvas used to have
 * no "open vs all" state at all, so the tab strip's X called
 * `deleteCanvasDocument` and destroyed the document, its versions and its
 * comments. Openness is a per-user layout preference, so it lives here rather
 * than on the document row: two people sharing a document do not share a tab
 * strip.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"

export type CanvasRightTab =
  "suggestions" | "history" | "comments" | "collaboration" | "execution" | "outline"

/** Left-rail presentation: time-grouped buckets vs a flat filename.ext list. */
export type CanvasRailViewMode = "grouped" | "files"

/**
 * Center-pane presentation: editor only, editor beside a live preview, or the
 * live preview alone. The `<CanvasPanel />` toolbar toggles between these; on
 * narrow panes / mobile "split" is treated as "code" (no side-by-side).
 */
export type CanvasPreviewMode = "code" | "split" | "preview"

export interface CanvasLayoutState {
  leftSize: number
  centerSize: number
  rightSize: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  activeRightTab: CanvasRightTab
  /** How the document rail lists documents (see CanvasRailViewMode). */
  railViewMode: CanvasRailViewMode
  /** How the center pane presents the editor / live preview (see CanvasPreviewMode). */
  previewMode: CanvasPreviewMode
  mobileLeftOpen: boolean
  mobileRightOpen: boolean
  /** Bumped on migrate / reset so ResizablePanelGroup remounts with new defaults. */
  layoutVersion: number
  /** Pinned document IDs — persisted as string[] and hydrated back to Set. */
  pinnedDocIds: Set<string>
  /**
   * Documents open in the tab strip, in tab order. A document can exist in the
   * workspace without being open; closing removes it from here and touches
   * nothing else.
   */
  openDocIds: string[]

  setSizes: (sizes: number[]) => void
  toggleLeft: () => void
  toggleRight: () => void
  setLeftCollapsed: (collapsed: boolean) => void
  setRightCollapsed: (collapsed: boolean) => void
  setActiveRightTab: (tab: CanvasRightTab) => void
  setRailViewMode: (mode: CanvasRailViewMode) => void
  setPreviewMode: (mode: CanvasPreviewMode) => void
  setMobileLeftOpen: (open: boolean) => void
  setMobileRightOpen: (open: boolean) => void
  resetLayout: () => void
  pinDocument: (id: string) => void
  unpinDocument: (id: string) => void
  isPinned: (id: string) => boolean
  /** Append to the tab strip if absent. Idempotent. */
  openDocument: (id: string) => void
  /**
   * Remove from the tab strip. Returns the id that should take focus when the
   * closed tab was the active one (the next tab, else the previous, else
   * `null`), so the caller does not have to re-derive tab order.
   */
  closeDocument: (id: string) => string | null
  /**
   * Drop several tabs at once, for the bulk paths that remove the documents
   * behind them (a purged workspace, a cleared conversation). Passing no ids
   * clears the strip.
   */
  closeDocuments: (ids?: string[]) => void
  isOpen: (id: string) => boolean
}

interface PersistedCanvasLayoutState {
  leftSize: number
  centerSize: number
  rightSize: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  activeRightTab: CanvasRightTab
  railViewMode: CanvasRailViewMode
  previewMode: CanvasPreviewMode
  layoutVersion: number
  pinnedDocIds: string[]
  openDocIds: string[]
}

export const CANVAS_LAYOUT_DEFAULTS = {
  leftSize: 16,
  centerSize: 64,
  rightSize: 20,
  leftCollapsed: false,
  rightCollapsed: false,
  activeRightTab: "suggestions" as CanvasRightTab,
  railViewMode: "grouped" as CanvasRailViewMode,
  previewMode: "split" as CanvasPreviewMode,
  layoutVersion: 0,
  pinnedDocIds: new Set<string>(),
  openDocIds: [] as string[],
}

export const CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS = 150

// Module-level debounce token shared across calls. Each `setSizes` invocation
// applies the new state immediately (so the UI tracks the drag) and schedules
// a single delayed `setState` that nudges Zustand's persist middleware to
// flush. Without this the persist layer writes localStorage on every animation
// frame while the user drags a divider.
let pendingFlush: ReturnType<typeof setTimeout> | null = null

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

export const useCanvasLayoutStore = create<CanvasLayoutState>()(
  persist(
    (set, get) => ({
      ...CANVAS_LAYOUT_DEFAULTS,
      mobileLeftOpen: false,
      mobileRightOpen: false,

      setSizes: (sizes) => {
        const [left, center, right] = sizes
        if (typeof left !== "number" || typeof center !== "number" || typeof right !== "number") {
          return
        }
        // Clamp each rail to its allowed range, derive center from remainder,
        // then scale so all three always sum to exactly 100.
        const clampedLeft = clamp(Math.max(12, Math.min(32, left)))
        const clampedRight = clamp(Math.max(16, Math.min(28, right)))
        const clampedCenter = clamp(Math.max(46, 100 - clampedLeft - clampedRight))
        const total = clampedLeft + clampedCenter + clampedRight
        const scale = total > 0 ? 100 / total : 1
        set({
          leftSize: clampedLeft * scale,
          centerSize: clampedCenter * scale,
          rightSize: clampedRight * scale,
        })
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          // Touching state again forces the persist middleware to write the
          // settled values exactly once after the drag stops.
          set({ leftSize: get().leftSize })
        }, CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS)
      },

      toggleLeft: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
      toggleRight: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),
      setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
      setRightCollapsed: (collapsed) => set({ rightCollapsed: collapsed }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      setRailViewMode: (mode) => set({ railViewMode: mode }),
      setPreviewMode: (mode) => set({ previewMode: mode }),
      setMobileLeftOpen: (open) => set({ mobileLeftOpen: open }),
      setMobileRightOpen: (open) => set({ mobileRightOpen: open }),
      resetLayout: () =>
        set((state) => ({
          ...CANVAS_LAYOUT_DEFAULTS,
          layoutVersion: state.layoutVersion + 1,
          mobileLeftOpen: false,
          mobileRightOpen: false,
        })),
      pinDocument: (id) =>
        set((state) => ({
          pinnedDocIds: new Set([...state.pinnedDocIds, id]),
        })),
      unpinDocument: (id) =>
        set((state) => {
          const next = new Set(state.pinnedDocIds)
          next.delete(id)
          return { pinnedDocIds: next }
        }),
      isPinned: (id) => get().pinnedDocIds.has(id),
      openDocument: (id) =>
        set((state) =>
          state.openDocIds.includes(id) ? state : { openDocIds: [...state.openDocIds, id] }
        ),
      closeDocument: (id) => {
        const { openDocIds } = get()
        const index = openDocIds.indexOf(id)
        if (index === -1) return null
        const next = openDocIds.filter((docId) => docId !== id)
        set({ openDocIds: next })
        // Focus the tab that slid into this slot, else the one before it. This
        // is the VS Code behaviour and the reason `closeDocument` returns an id
        // instead of leaving the caller to guess from a list it already lost.
        return next[index] ?? next[index - 1] ?? null
      },
      closeDocuments: (ids) =>
        set((state) =>
          ids === undefined
            ? { openDocIds: [] }
            : { openDocIds: state.openDocIds.filter((docId) => !ids.includes(docId)) }
        ),
      isOpen: (id) => get().openDocIds.includes(id),
    }),
    {
      name: "cognia-canvas-layout",
      storage: persistLocalStorage(),
      version: 6,
      migrate: (_oldState: unknown, _oldVersion: number) => ({
        ...CANVAS_LAYOUT_DEFAULTS,
        layoutVersion: 1,
        mobileLeftOpen: false,
        mobileRightOpen: false,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Set → array serialization
      partialize: (state): any => ({
        leftSize: state.leftSize,
        centerSize: state.centerSize,
        rightSize: state.rightSize,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        activeRightTab: state.activeRightTab,
        railViewMode: state.railViewMode,
        previewMode: state.previewMode,
        layoutVersion: state.layoutVersion,
        pinnedDocIds: [...state.pinnedDocIds],
        openDocIds: [...state.openDocIds],
      }),
      merge: (persisted: unknown, current: CanvasLayoutState) => {
        const p = persisted as PersistedCanvasLayoutState
        return {
          ...current,
          ...p,
          pinnedDocIds: new Set(p.pinnedDocIds ?? []),
          openDocIds: [...(p.openDocIds ?? [])],
        } as CanvasLayoutState
      },
    }
  )
)

export default useCanvasLayoutStore
