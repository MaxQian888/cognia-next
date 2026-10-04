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
 * conversation had the dock open. That lives here.
 *
 * Page tabs are the exception: nothing else owns them. A page tab is an address
 * the task has open (ADR-0214, D8 / D10) — its URL, title and engine — and it
 * outlives the Chromium page behind it, which closes when the task goes to the
 * background and is opened again from the URL here when the tab is next shown.
 * Which runtime page stands behind a tab right now is not remembered: it is
 * live state of the shared browser session (`lib/browser/shared-local-browser`).
 *
 * Width stays global (`artifactDockLayoutStore.dockSize`) on purpose.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"
import { pruneByLastUsed } from "@/stores/context-workbench/context-workbench-store"

/** A tab's identity across kinds: `panel:<panelId>`, `artifact:<artifactId>` or `page:<tabId>`. */
export type DockTabKey = `panel:${string}` | `artifact:${string}` | `page:${string}`

export function panelTabKey(panelId: string): DockTabKey {
  return `panel:${panelId}`
}

export function artifactTabKey(artifactId: string): DockTabKey {
  return `artifact:${artifactId}`
}

export function pageTabKey(tabId: string): DockTabKey {
  return `page:${tabId}`
}

export function parseDockTabKey(
  key: DockTabKey
):
  | { kind: "panel"; panelId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "page"; tabId: string } {
  if (key.startsWith("panel:")) return { kind: "panel", panelId: key.slice("panel:".length) }
  if (key.startsWith("page:")) return { kind: "page", tabId: key.slice("page:".length) }
  return { kind: "artifact", artifactId: key.slice("artifact:".length) }
}

/**
 * Which engine serves a page tab. `auto` follows the user's default (local
 * Chromium once installed); `embedded` is the lightweight preview on the
 * system webview; the rest are explicit picks from the engine switcher.
 */
export type DockPageEngine = "auto" | "local-chromium" | "embedded" | "user-chrome" | "remote"

export interface DockPageTab {
  id: string
  /** Where the tab is — what it reopens on after its page was closed. */
  url: string
  title: string
  engine: DockPageEngine
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
  /** The task's open addresses, in the order they were opened. */
  pages: DockPageTab[]
  /** The page tab the browser panel shows. */
  activePageTabId: string | null
  lastUsedAt: number
}

const EMPTY_ENTRY: Omit<SessionDockTabs, "lastUsedAt"> = {
  order: [],
  dock: null,
  pages: [],
  activePageTabId: null,
}

/** Mint a page tab id. */
export function newPageTabId(): string {
  return `pt-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
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
  /**
   * Add a page tab. `replacing` is the tab it takes the place of on the strip
   * (the New Tab page it was opened from), as `replaceTab` does.
   */
  addPageTab: (
    sessionId: string,
    tab: DockPageTab,
    options?: { activate?: boolean; replacing?: DockTabKey; currentOrder?: readonly DockTabKey[] }
  ) => void
  updatePageTab: (
    sessionId: string,
    tabId: string,
    patch: Partial<Pick<DockPageTab, "url" | "title" | "engine">>
  ) => void
  /** Close a page tab; the browser panel shows the most recently opened one left. */
  removePageTab: (sessionId: string, tabId: string) => void
  setActivePageTab: (sessionId: string, tabId: string | null) => void
}

function touch(
  bySession: Record<string, SessionDockTabs>,
  sessionId: string,
  update: (entry: SessionDockTabs) => SessionDockTabs
): Record<string, SessionDockTabs> {
  const now = Date.now()
  const current = normalizeEntry(bySession[sessionId], now)
  return pruneByLastUsed(
    { ...bySession, [sessionId]: { ...update(current), lastUsedAt: now } },
    now
  )
}

/** An entry as stored, filling what an older version of it did not have. */
function normalizeEntry(entry: Partial<SessionDockTabs> | undefined, now: number): SessionDockTabs {
  return {
    ...EMPTY_ENTRY,
    ...entry,
    pages: Array.isArray(entry?.pages) ? entry.pages : [],
    activePageTabId: entry?.activePageTabId ?? null,
    lastUsedAt: entry?.lastUsedAt ?? now,
  }
}

function normalizeAll(
  bySession: Record<string, Partial<SessionDockTabs>> | undefined
): Record<string, SessionDockTabs> {
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(bySession ?? {}).map(([sessionId, entry]) => [
      sessionId,
      normalizeEntry(entry, now),
    ])
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
      addPageTab: (sessionId, tab, options = {}) =>
        set((state) => ({
          bySession: touch(state.bySession, sessionId, (entry) => {
            const key = pageTabKey(tab.id)
            const order =
              options.replacing && options.currentOrder?.includes(options.replacing)
                ? options.currentOrder.map((existing) =>
                    existing === options.replacing ? key : existing
                  )
                : entry.order
            return {
              ...entry,
              order,
              pages: [...entry.pages.filter((page) => page.id !== tab.id), tab],
              activePageTabId: options.activate ? tab.id : (entry.activePageTabId ?? tab.id),
            }
          }),
        })),
      updatePageTab: (sessionId, tabId, patch) =>
        set((state) => {
          const page = state.bySession[sessionId]?.pages?.find((entry) => entry.id === tabId)
          if (!page) return state
          if (
            (patch.url === undefined || patch.url === page.url) &&
            (patch.title === undefined || patch.title === page.title) &&
            (patch.engine === undefined || patch.engine === page.engine)
          ) {
            return state
          }
          return {
            bySession: touch(state.bySession, sessionId, (entry) => ({
              ...entry,
              pages: entry.pages.map((existing) =>
                existing.id === tabId ? { ...existing, ...patch } : existing
              ),
            })),
          }
        }),
      removePageTab: (sessionId, tabId) =>
        set((state) => {
          if (!state.bySession[sessionId]?.pages?.some((page) => page.id === tabId)) return state
          return {
            bySession: touch(state.bySession, sessionId, (entry) => {
              const pages = entry.pages.filter((page) => page.id !== tabId)
              return {
                ...entry,
                order: entry.order.filter((key) => key !== pageTabKey(tabId)),
                pages,
                activePageTabId:
                  entry.activePageTabId === tabId
                    ? (pages.at(-1)?.id ?? null)
                    : entry.activePageTabId,
              }
            }),
          }
        }),
      setActivePageTab: (sessionId, tabId) =>
        set((state) => {
          const entry = state.bySession[sessionId]
          if (entry?.activePageTabId === tabId) return state
          if (tabId && !entry?.pages?.some((page) => page.id === tabId)) return state
          return {
            bySession: touch(state.bySession, sessionId, (current) => ({
              ...current,
              activePageTabId: tabId,
            })),
          }
        }),
    }),
    {
      name: "cognia-dock-tabs-v1",
      storage: persistLocalStorage(),
      // v2: page tabs (ADR-0214, D9). A v1 entry simply has none.
      version: 2,
      migrate: (persisted) => ({
        bySession: normalizeAll(
          (persisted as { bySession?: Record<string, Partial<SessionDockTabs>> } | undefined)
            ?.bySession
        ),
      }),
      partialize: (state) => ({ bySession: pruneByLastUsed(state.bySession) }),
      merge: (persisted, current) => ({
        ...current,
        bySession: pruneByLastUsed(
          normalizeAll((persisted as Partial<DockTabsState> | undefined)?.bySession)
        ),
      }),
    }
  )
)

const EMPTY_PAGES: DockPageTab[] = []

/** A conversation's page tabs. */
export function selectPageTabs(state: DockTabsState, sessionId: string | null): DockPageTab[] {
  return (sessionId ? state.bySession[sessionId]?.pages : undefined) ?? EMPTY_PAGES
}

/** The page tab a conversation's browser panel shows, if it still exists. */
export function selectActivePageTab(
  state: DockTabsState,
  sessionId: string | null
): DockPageTab | null {
  if (!sessionId) return null
  const entry = state.bySession[sessionId]
  return entry?.pages?.find((page) => page.id === entry.activePageTabId) ?? null
}

/** The remembered dock for `sessionId`, or `null` when the user never set one there. */
export function rememberedDockFor(sessionId: string | null): RememberedDock | null {
  if (!sessionId) return null
  return useDockTabsStore.getState().bySession[sessionId]?.dock ?? null
}
