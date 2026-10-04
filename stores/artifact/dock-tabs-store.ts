"use client"

/**
 * The chat dock's per-task memory (ADR-0214, D6 / D9): the order of the one
 * tab strip, and whether the dock was open, for each conversation.
 *
 * Deliberately not a second copy of the tabs. The strip mixes kinds that
 * already have owners, and each owner already remembers them per conversation:
 *
 * - **artifact tabs** — `artifactStore.openArtifactIdsBySession` and the
 *   active one in `activeArtifactIdBySession`;
 * - **panel tabs** (the session surface's side chat, workspace, browser, task
 *   overview, the New Tab page …) — the session scope's `activatedPanelIds`
 *   and `activePanelId` in `contextWorkbenchStore` (R6: the workbench keeps
 *   mount and lifecycle, the dock drives it through `navigatePanel` /
 *   `closePanelTab`).
 *
 * A third list of the same tabs would drift from both the first time something
 * outside the strip opened one — and almost everything does: an artifact
 * arriving, a reveal from the chat, the command palette. What none of them can
 * say is how the user arranged those tabs *across* kinds, or whether this
 * conversation had the dock open. Only that lives here.
 *
 * Width stays global (`artifactDockLayoutStore.dockSize`) on purpose.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"
import { pruneByLastUsed } from "@/stores/context-workbench/context-workbench-store"

/** A tab's identity across kinds: `panel:<panelId>` or `artifact:<artifactId>`. */
export type DockTabKey = `panel:${string}` | `artifact:${string}`

export function panelTabKey(panelId: string): DockTabKey {
  return `panel:${panelId}`
}

export function artifactTabKey(artifactId: string): DockTabKey {
  return `artifact:${artifactId}`
}

export function parseDockTabKey(
  key: DockTabKey
): { kind: "panel"; panelId: string } | { kind: "artifact"; artifactId: string } {
  return key.startsWith("panel:")
    ? { kind: "panel", panelId: key.slice("panel:".length) }
    : { kind: "artifact", artifactId: key.slice("artifact:".length) }
}

/**
 * The dock as the user left it in one conversation. `dismissed` is kept apart
 * from `open` because they mean different things on the way back: a dock the
 * user closed stays closed when an artifact is parked there (the toggle only
 * shows the unread dot), while one that was merely idle opens for the next
 * artifact that arrives — the same distinction `userDismissed` draws today.
 */
export interface RememberedDock {
  open: boolean
  dismissed: boolean
}

export interface SessionDockTabs {
  /** Arrangement the user chose; tabs it does not mention follow, in arrival order. */
  order: DockTabKey[]
  dock: RememberedDock | null
  lastUsedAt: number
}

/**
 * Lay `present` out in the stored order: tabs the user arranged keep their
 * places, newcomers follow in the order their owners report them, and keys
 * whose tab is gone are dropped.
 */
export function orderDockTabs(
  stored: readonly DockTabKey[] | undefined,
  present: readonly DockTabKey[]
): DockTabKey[] {
  if (!stored?.length) return [...present]
  const presentSet = new Set(present)
  const arranged = stored.filter((key) => presentSet.has(key))
  const arrangedSet = new Set(arranged)
  return [...arranged, ...present.filter((key) => !arrangedSet.has(key))]
}

interface DockTabsState {
  bySession: Record<string, SessionDockTabs>
  /**
   * Move `key` to `toIndex` within `currentOrder` — the strip as it is drawn,
   * so tabs the user never arranged are pinned where they appeared.
   */
  moveTab: (
    sessionId: string,
    currentOrder: readonly DockTabKey[],
    key: DockTabKey,
    toIndex: number
  ) => void
  /**
   * `to` takes `from`'s place in `currentOrder` — a tool opened from the New
   * Tab page lands where that page was, the way a link replaces a browser's
   * start page. When `to` is already on the strip it keeps its own place and
   * `from` simply leaves.
   */
  replaceTab: (
    sessionId: string,
    currentOrder: readonly DockTabKey[],
    from: DockTabKey,
    to: DockTabKey
  ) => void
  /** Record how the dock stands for this conversation. */
  rememberDock: (sessionId: string, dock: RememberedDock) => void
}

function touch(
  bySession: Record<string, SessionDockTabs>,
  sessionId: string,
  update: (entry: SessionDockTabs) => SessionDockTabs
): Record<string, SessionDockTabs> {
  const now = Date.now()
  const current = bySession[sessionId] ?? { order: [], dock: null, lastUsedAt: now }
  return pruneByLastUsed(
    { ...bySession, [sessionId]: { ...update(current), lastUsedAt: now } },
    now
  )
}

export const useDockTabsStore = create<DockTabsState>()(
  persist(
    (set) => ({
      bySession: {},
      moveTab: (sessionId, currentOrder, key, toIndex) =>
        set((state) => {
          const from = currentOrder.indexOf(key)
          if (from === -1) return state
          const target = Math.max(0, Math.min(currentOrder.length - 1, toIndex))
          if (target === from) return state
          const order = [...currentOrder]
          order.splice(from, 1)
          order.splice(target, 0, key)
          return { bySession: touch(state.bySession, sessionId, (entry) => ({ ...entry, order })) }
        }),
      replaceTab: (sessionId, currentOrder, from, to) =>
        set((state) => {
          if (!currentOrder.includes(from)) return state
          const order = currentOrder.includes(to)
            ? currentOrder.filter((key) => key !== from)
            : currentOrder.map((key) => (key === from ? to : key))
          return { bySession: touch(state.bySession, sessionId, (entry) => ({ ...entry, order })) }
        }),
      rememberDock: (sessionId, dock) =>
        set((state) => {
          const current = state.bySession[sessionId]?.dock
          if (current && current.open === dock.open && current.dismissed === dock.dismissed) {
            return state
          }
          return {
            bySession: touch(state.bySession, sessionId, (entry) => ({ ...entry, dock })),
          }
        }),
    }),
    {
      name: "cognia-dock-tabs-v1",
      storage: persistLocalStorage(),
      version: 1,
      partialize: (state) => ({ bySession: pruneByLastUsed(state.bySession) }),
      merge: (persisted, current) => ({
        ...current,
        bySession: pruneByLastUsed(
          (persisted as Partial<DockTabsState> | undefined)?.bySession ?? {}
        ),
      }),
    }
  )
)

/** The remembered dock for `sessionId`, or `null` when the user never set one there. */
export function rememberedDockFor(sessionId: string | null): RememberedDock | null {
  if (!sessionId) return null
  return useDockTabsStore.getState().bySession[sessionId]?.dock ?? null
}
