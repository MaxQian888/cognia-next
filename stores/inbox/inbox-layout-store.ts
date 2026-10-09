/**
 * Inbox Layout Store — persisted layout choices for the Inbox shell.
 *
 * Owns:
 *  - sidebar/list/detail pane sizes (percent). The `<InboxShell />` component
 *    calls `setSizes` on every drag tick of the ResizablePanelGroup;
 *    persistence is debounced internally so localStorage isn't thrashed. Only
 *    used on `≥ 1024 px` viewports; tablet and phone use a flex layout.
 *  - the list grouping the user last picked. The URL's `?group=` wins when
 *    present (deep links); this is what a route without one falls back to, so
 *    moving between `/inbox/all` and a scoped route keeps the user's choice.
 *  - explicit section collapse choices, keyed by section id
 *    (`lib/inbox/conversation-grouping.ts`). Only choices are stored; a
 *    section with no entry takes its default (tails collapsed).
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { isInboxGrouping, type InboxGrouping } from "@/lib/inbox/inbox-url-state"

export interface InboxLayoutState {
  sidebarSize: number
  listSize: number
  detailSize: number
  /** `null` until the user picks one; routes then use their default. */
  grouping: InboxGrouping | null
  /** Explicit collapse choices by section id. */
  collapsedSections: Record<string, boolean>
  setSizes: (sizes: [number, number, number]) => void
  setGrouping: (grouping: InboxGrouping) => void
  setSectionCollapsed: (sectionId: string, collapsed: boolean) => void
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

/**
 * Cap on stored collapse choices. Section ids include adapter ids, which come
 * and go; without a bound the map would grow for the life of the install.
 * Oldest choices (insertion order) are dropped first.
 */
export const INBOX_COLLAPSED_SECTIONS_MAX = 64

const LAYOUT_PREFERENCE_DEFAULTS = {
  grouping: null as InboxGrouping | null,
  collapsedSections: {} as Record<string, boolean>,
}

function sanitizeCollapsedSections(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
  )
  return Object.fromEntries(entries.slice(-INBOX_COLLAPSED_SECTIONS_MAX))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/**
 * Persisted-state migration.
 *
 * v1 → anything: v1 layouts were persisted while `<InboxShell />` passed bare
 * numbers to react-resizable-panels v4 (interpreted as pixels, not percent),
 * so every drag stored clamped garbage — discarded.
 * v2 → v3: sizes are kept; v3 adds the grouping and collapse choices.
 */
export function migrateInboxLayoutState(
  persisted: unknown,
  version: number
): Pick<
  InboxLayoutState,
  "sidebarSize" | "listSize" | "detailSize" | "grouping" | "collapsedSections"
> {
  const old = (persisted && typeof persisted === "object" ? persisted : {}) as Record<
    string,
    unknown
  >
  const sizes =
    version >= 2
      ? {
          sidebarSize: finiteOr(old.sidebarSize, INBOX_LAYOUT_DEFAULTS.sidebarSize),
          listSize: finiteOr(old.listSize, INBOX_LAYOUT_DEFAULTS.listSize),
          detailSize: finiteOr(old.detailSize, INBOX_LAYOUT_DEFAULTS.detailSize),
        }
      : { ...INBOX_LAYOUT_DEFAULTS }
  return {
    ...sizes,
    grouping: isInboxGrouping(old.grouping) ? old.grouping : null,
    collapsedSections: sanitizeCollapsedSections(old.collapsedSections),
  }
}

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
      ...LAYOUT_PREFERENCE_DEFAULTS,

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

      setGrouping: (grouping) => {
        if (!isInboxGrouping(grouping)) return
        set({ grouping })
      },

      setSectionCollapsed: (sectionId, collapsed) => {
        if (!sectionId) return
        const next = { ...get().collapsedSections }
        // Re-insert so the latest choice is the newest entry for the cap.
        delete next[sectionId]
        next[sectionId] = collapsed
        set({ collapsedSections: sanitizeCollapsedSections(next) })
      },

      reset: () => set({ ...INBOX_LAYOUT_DEFAULTS, ...LAYOUT_PREFERENCE_DEFAULTS }),
    }),
    {
      name: "cognia-inbox-layout",
      storage: persistLocalStorage(),
      // See `migrateInboxLayoutState` for what each bump changed.
      version: 3,
      migrate: (oldState: unknown, oldVersion: number) =>
        migrateInboxLayoutState(oldState, oldVersion) as InboxLayoutState,
      partialize: (state) => ({
        sidebarSize: state.sidebarSize,
        listSize: state.listSize,
        detailSize: state.detailSize,
        grouping: state.grouping,
        collapsedSections: state.collapsedSections,
      }),
    }
  )
)

export default useInboxLayoutStore
