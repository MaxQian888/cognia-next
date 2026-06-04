/**
 * Inbox Layout Store — persisted three-pane sizing for the desktop Inbox shell.
 *
 * Owns: sidebar/list/detail pane sizes (percent). The `<InboxShell />`
 * component calls `setSizes` on every drag tick of the ResizablePanelGroup;
 * persistence is debounced internally so localStorage isn't thrashed.
 *
 * Layout policy: only used on `≥ 1024 px` viewports. Tablet and mobile
 * branches of `<InboxShell />` fall back to the responsive flex layout
 * unchanged.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface InboxLayoutState {
  sidebarSize: number
  listSize: number
  detailSize: number
  setSizes: (sizes: [number, number, number]) => void
  reset: () => void
}

export const INBOX_LAYOUT_DEFAULTS = {
  sidebarSize: 18,
  listSize: 26,
  detailSize: 56,
}

export const INBOX_LAYOUT_BOUNDS = {
  sidebarMin: 12,
  sidebarMax: 28,
  listMin: 18,
  listMax: 40,
  detailMin: 40,
}

export const INBOX_LAYOUT_PERSIST_DEBOUNCE_MS = 150

let pendingFlush: ReturnType<typeof setTimeout> | null = null

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

export const useInboxLayoutStore = create<InboxLayoutState>()(
  persist(
    (set, get) => ({
      ...INBOX_LAYOUT_DEFAULTS,

      setSizes: (sizes) => {
        const [sidebar, list, detail] = sizes
        if (typeof sidebar !== "number" || typeof list !== "number" || typeof detail !== "number") {
          return
        }
        const { sidebarMin, sidebarMax, listMin, listMax, detailMin } = INBOX_LAYOUT_BOUNDS
        const clampedSidebar = clamp(sidebar, sidebarMin, sidebarMax)
        const clampedList = clamp(list, listMin, listMax)
        const clampedDetail = clamp(100 - clampedSidebar - clampedList, detailMin, 100)
        const total = clampedSidebar + clampedList + clampedDetail
        const scale = total > 0 ? 100 / total : 1
        set({
          sidebarSize: clampedSidebar * scale,
          listSize: clampedList * scale,
          detailSize: clampedDetail * scale,
        })
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          // Re-touch state to make the persist middleware flush the settled
          // sizes exactly once after the drag stops.
          set({ sidebarSize: get().sidebarSize })
        }, INBOX_LAYOUT_PERSIST_DEBOUNCE_MS)
      },

      reset: () => set({ ...INBOX_LAYOUT_DEFAULTS }),
    }),
    {
      name: "cognia-inbox-layout",
      // v2: v1 layouts were persisted while `<InboxShell />` passed bare
      // numbers to react-resizable-panels v4 (interpreted as pixels, not
      // percent), so every drag stored clamped garbage — discard them.
      version: 2,
      migrate: (_oldState: unknown, _oldVersion: number) => ({
        ...INBOX_LAYOUT_DEFAULTS,
      }),
      partialize: (state) => ({
        sidebarSize: state.sidebarSize,
        listSize: state.listSize,
        detailSize: state.detailSize,
      }),
    }
  )
)

export default useInboxLayoutStore
