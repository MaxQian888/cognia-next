/**
 * The chat dock's page tabs (ADR-0214, D6 / D8 / D9 / D10): what opens them,
 * what they stand for in the shared browser session, and when their pages
 * close.
 *
 * A page tab is an address a task has open (`dockTabsStore`), shown by the one
 * `browser` panel. On local Chromium a tab is backed by a runtime page the
 * task owns (`chat:<sessionId>` in `shared-local-browser`), opened lazily the
 * first time the tab is shown and closed again when the task goes to the
 * background — unless its run is still in flight, in which case the pages wait
 * for the run to settle. Coming back reopens a page only when its tab is shown.
 *
 * Two directions are kept in step here, because neither side can see the
 * other: the strip opens and closes tabs, while the runtime opens and closes
 * pages on its own (an agent's new tab, a popup, a page calling
 * `window.close()`). `startDockPageSync` mirrors the second into the first.
 */

import { getContextWorkbenchWindowScope } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  chatPageOwner,
  chatSessionOfOwner,
  closeSharedPage,
  releaseOwner,
  setFocusPageTagResolver,
  sharedLocalBrowserStore,
  tagSharedPage,
  taggedPage,
  type SharedLocalBrowserState,
} from "@/lib/browser/shared-local-browser"
import { isInFlight } from "@/lib/chat/aggregate-run-state"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  newPageTabId,
  selectActivePageTab,
  selectPageTabs,
  useDockTabsStore,
  type DockPageEngine,
  type DockPageTab,
  type DockTabKey,
} from "@/stores/artifact/dock-tabs-store"
import { useChatStore } from "@/stores/chat"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  NEW_TAB_PANEL_ID,
  sessionWorkbenchScopeKey,
} from "./session-workbench-scope-key"

/** The panel that shows a conversation's active page tab. */
export const DOCK_BROWSER_PANEL_ID = "browser"

/** The dock's session-surface scope for `sessionId`, outside React. */
export function dockSessionScopeKey(sessionId: string | null): string {
  return sessionWorkbenchScopeKey(
    `${getContextWorkbenchWindowScope()}:${ARTIFACT_DOCK_WORKBENCH_HOST_KEY}`,
    sessionId
  )
}

function parkArtifact(sessionId: string | null): void {
  const artifacts = useArtifactStore.getState()
  if (selectActiveArtifactId(artifacts, sessionId)) artifacts.setActiveArtifact(null, sessionId)
}

/**
 * Open (or focus) the New Tab page for a conversation: park its artifact, bring
 * the page forward in the session scope, and open the dock if it was shut.
 * The strip's `+`, ⌘T and a browser with nothing to show are this one path.
 */
export function openDockNewTab(sessionId: string | null, sessionScopeKey: string): void {
  parkArtifact(sessionId)
  useContextWorkbenchStore.getState().navigatePanel(sessionScopeKey, NEW_TAB_PANEL_ID)
  const dock = useArtifactDockLayoutStore.getState()
  if (dock.dockCollapsed) dock.setDockCollapsed(false)
}

/**
 * Show a page tab: the browser panel in front, on that tab. `reveal: false`
 * only arranges a conversation that is not on screen, so it shows the tab when
 * the user goes there; the dock in front is left alone.
 */
export function activateDockPageTab(
  sessionId: string,
  tabId: string,
  options: { reveal?: boolean } = {}
): void {
  useDockTabsStore.getState().setActivePageTab(sessionId, tabId)
  useContextWorkbenchStore
    .getState()
    .navigatePanel(dockSessionScopeKey(sessionId), DOCK_BROWSER_PANEL_ID, "wide")
  if (options.reveal === false) return
  parkArtifact(sessionId)
  // The reveal widens the dock for the page and opens it if it was shut.
  useArtifactDockLayoutStore.getState().openBrowser()
}

/** The engine a request asks a new tab for, in the strip's vocabulary. */
export function dockPageEngineFor(backend: BrowserBackend | undefined): DockPageEngine {
  switch (backend) {
    case "embedded":
    case "local-chromium":
    case "user-chrome":
    case "remote":
      return backend
    default:
      return "auto"
  }
}

export interface DockPageRequest {
  source?: "user" | "agent"
  backend?: BrowserBackend
  /** Always a new tab, even when one could be reused. */
  newTab?: boolean
  /** The tab the new page takes the place of on the strip (the New Tab page it came from). */
  replacing?: DockTabKey
  /** The strip as drawn, for `replacing`. */
  currentOrder?: readonly DockTabKey[]
  /**
   * Put the dock on screen. False for a conversation in the background — its
   * agent's page lines up there without taking over the dock in front.
   */
  reveal?: boolean
}

/** The tab a conversation's agent is driving on local Chromium, if it has one. */
function agentTab(sessionId: string): DockPageTab | null {
  const { focus, owned } = sharedLocalBrowserStore.getState()
  const pageId = focus[chatPageOwner(sessionId)]
  const tag = pageId ? owned[pageId]?.tag : null
  return tag
    ? (selectPageTabs(useDockTabsStore.getState(), sessionId).find((tab) => tab.id === tag) ?? null)
    : null
}

function addTab(sessionId: string, url: string, request: DockPageRequest): string {
  const tab: DockPageTab = {
    id: newPageTabId(),
    url,
    title: "",
    engine: dockPageEngineFor(request.backend),
  }
  useDockTabsStore.getState().addPageTab(sessionId, tab, {
    activate: true,
    ...(request.replacing ? { replacing: request.replacing } : {}),
    ...(request.currentOrder ? { currentOrder: request.currentOrder } : {}),
  })
  return tab.id
}

/**
 * Show `url` in a conversation's dock, returning the tab it went to (null when
 * there was nothing to show and the New Tab page opened instead).
 *
 * - A user's link reuses a tab already on that address, else opens a new tab.
 * - An agent reuses its own tab: the lightweight one for a lightweight request,
 *   else the tab whose page it is driving. An agent with no page yet gets a new
 *   tab, which its first page then fills (`setFocusPageTagResolver`).
 * - An empty address shows what the conversation has open.
 */
export function openDockPage(
  sessionId: string,
  url: string,
  request: DockPageRequest = {}
): string | null {
  const store = useDockTabsStore.getState()
  const tabs = selectPageTabs(store, sessionId)
  const active = selectActivePageTab(store, sessionId)
  let tabId: string | null = null

  if (!url) {
    tabId = active?.id ?? tabs.at(-1)?.id ?? null
    if (request.source === "agent" && request.backend !== "embedded") {
      tabId = agentTab(sessionId)?.id ?? tabId
    }
  } else if (request.newTab) {
    tabId = addTab(sessionId, url, request)
  } else if (request.source === "agent") {
    if (request.backend === "embedded") {
      const lightweight =
        active?.engine === "embedded" ? active : tabs.findLast((tab) => tab.engine === "embedded")
      if (lightweight) {
        store.updatePageTab(sessionId, lightweight.id, { url })
        tabId = lightweight.id
      }
    } else {
      tabId = agentTab(sessionId)?.id ?? null
    }
    tabId ??= addTab(sessionId, url, request)
  } else {
    tabId = tabs.find((tab) => tab.url === url)?.id ?? addTab(sessionId, url, request)
  }

  if (!tabId) {
    if (request.reveal !== false) openDockNewTab(sessionId, dockSessionScopeKey(sessionId))
    return null
  }
  activateDockPageTab(sessionId, tabId, { reveal: request.reveal })
  return tabId
}

/**
 * Close a page tab and its page. The last one closes the browser panel too:
 * with no tab to show it would only hold an empty slot on the strip.
 */
export function closeDockPageTab(sessionId: string, tabId: string): void {
  const page = taggedPage(chatPageOwner(sessionId), tabId)
  if (page) {
    released.add(page.id)
    void closeSharedPage(page.id).catch(() => undefined)
  }
  const store = useDockTabsStore.getState()
  store.removePageTab(sessionId, tabId)
  if (selectPageTabs(useDockTabsStore.getState(), sessionId).length === 0) {
    useContextWorkbenchStore
      .getState()
      .closePanelTab(dockSessionScopeKey(sessionId), DOCK_BROWSER_PANEL_ID)
  }
}

/**
 * Switch a tab between Chromium and the lightweight preview. Leaving Chromium
 * closes the tab's page — the preview loads the address itself — so a tab
 * never holds a page nobody can see.
 */
export function setDockPageEngine(sessionId: string, tabId: string, engine: DockPageEngine): void {
  useDockTabsStore.getState().updatePageTab(sessionId, tabId, { engine })
  if (engine === "auto" || engine === "local-chromium") return
  const page = taggedPage(chatPageOwner(sessionId), tabId)
  if (page) {
    released.add(page.id)
    void closeSharedPage(page.id).catch(() => undefined)
  }
}

/** Pages closed on purpose: their tabs stay when the pages go. */
const released = new Set<string>()

/** Close a conversation's pages and keep its tabs, which reopen on demand. */
export async function releaseDockPages(sessionId: string): Promise<void> {
  const owner = chatPageOwner(sessionId)
  const { owned } = sharedLocalBrowserStore.getState()
  for (const [pageId, entry] of Object.entries(owned)) {
    if (entry.owner === owner) released.add(pageId)
  }
  await releaseOwner(owner)
}

/** A title worth showing; the runtime reports "" while a page loads. */
function pageTitle(title: string, url: string): string {
  return title || (url === "about:blank" ? "" : url)
}

/**
 * Mirror the runtime's pages into the conversations' page tabs:
 *
 * - a page a conversation's agent or one of its pages opened gets a tab;
 * - a tab follows its page's address and title (a fresh page is `about:blank`
 *   until it loads, which never overwrites the address the tab remembers);
 * - a page that closed by itself takes its tab with it, unless it was closed
 *   on purpose (`released`) or the whole session went away;
 * - the tab on screen follows the page the conversation's agent moved to.
 *
 * Also lets an agent's first page fill the tab the conversation is showing.
 * Returns the unsubscribe.
 */
export function startDockPageSync(): () => void {
  setFocusPageTagResolver((owner) => {
    const sessionId = chatSessionOfOwner(owner)
    if (!sessionId) return null
    const tab = selectActivePageTab(useDockTabsStore.getState(), sessionId)
    if (!tab || (tab.engine !== "auto" && tab.engine !== "local-chromium")) return null
    return taggedPage(owner, tab.id) ? null : tab.id
  })
  const sync = (state: SharedLocalBrowserState, previous: SharedLocalBrowserState) => {
    if (!state.sessionId) {
      released.clear()
      return
    }
    const tabs = () => useDockTabsStore.getState()
    const alive = new Set(state.pages.map((page) => page.id))
    for (const [pageId, entry] of Object.entries(previous.owned)) {
      if (alive.has(pageId) || state.sessionId !== previous.sessionId) continue
      const sessionId = chatSessionOfOwner(entry.owner)
      if (released.delete(pageId) || !sessionId || !entry.tag) continue
      tabs().removePageTab(sessionId, entry.tag)
    }
    for (const page of state.pages) {
      const entry = state.owned[page.id]
      const sessionId = entry ? chatSessionOfOwner(entry.owner) : null
      if (!entry || !sessionId) continue
      if (!entry.tag) {
        const tab: DockPageTab = {
          id: newPageTabId(),
          url: page.url,
          title: pageTitle(page.title, page.url),
          engine: "auto",
        }
        // The tab first: tagging re-enters this listener, which then finds it.
        tabs().addPageTab(sessionId, tab)
        tagSharedPage(page.id, tab.id)
        continue
      }
      const tab = selectPageTabs(tabs(), sessionId).find((existing) => existing.id === entry.tag)
      if (!tab) continue
      if (page.url && page.url !== "about:blank") {
        tabs().updatePageTab(sessionId, tab.id, {
          url: page.url,
          title: pageTitle(page.title, page.url),
        })
      }
    }
    for (const [owner, pageId] of Object.entries(state.focus)) {
      if (previous.focus[owner] === pageId) continue
      const sessionId = chatSessionOfOwner(owner)
      const tag = sharedLocalBrowserStore.getState().owned[pageId]?.tag
      if (sessionId && tag) useDockTabsStore.getState().setActivePageTab(sessionId, tag)
    }
  }
  const unsubscribe = sharedLocalBrowserStore.subscribe(sync)
  return () => {
    unsubscribe()
    setFocusPageTagResolver(null)
  }
}

/**
 * D10: a conversation's pages follow it. Leaving a conversation closes its
 * pages, unless its run is in flight (streaming or awaiting approval) — then
 * they close when the run settles, if the conversation is still in the
 * background. Returns the unsubscribe.
 */
export function subscribeDockPageLifecycle(): () => void {
  const waiting = new Map<string, () => void>()
  const statusOf = (sessionId: string) =>
    useChatStore.getState().sessions[sessionId]?.status ?? "idle"
  const leave = (sessionId: string) => {
    if (!isInFlight(statusOf(sessionId))) {
      void releaseDockPages(sessionId)
      return
    }
    if (waiting.has(sessionId)) return
    const stop = useChatStore.subscribe((state) => {
      if (state.activeSessionId === sessionId) {
        stop()
        waiting.delete(sessionId)
        return
      }
      if (isInFlight(state.sessions[sessionId]?.status ?? "idle")) return
      stop()
      waiting.delete(sessionId)
      void releaseDockPages(sessionId)
    })
    waiting.set(sessionId, stop)
  }
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    if (state.activeSessionId === previous.activeSessionId) return
    if (state.activeSessionId) {
      waiting.get(state.activeSessionId)?.()
      waiting.delete(state.activeSessionId)
    }
    if (previous.activeSessionId) leave(previous.activeSessionId)
  })
  return () => {
    unsubscribe()
    for (const stop of waiting.values()) stop()
    waiting.clear()
  }
}

/** Test seam. */
export function resetDockPagesForTests(): void {
  released.clear()
}
