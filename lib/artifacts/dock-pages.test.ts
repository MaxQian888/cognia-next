/** @jest-environment jsdom */
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    onEvent: jest.fn(),
    createSession: jest.fn(),
    closeSession: jest.fn(),
    subscribeFrames: jest.fn(),
    rpc: jest.fn(),
  },
}))

import { localBrowser, type LocalBrowserEvent } from "@/lib/browser/local-client"
import {
  ensureOwnerFocusPage,
  ensureTaggedPage,
  openOwnedPage,
  ownedPageEngine,
  resetSharedLocalBrowserForTests,
  sharedLocalBrowserStore,
  taggedPage,
} from "@/lib/browser/shared-local-browser"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  pageTabKey,
  panelTabKey,
  selectActivePageTab,
  selectPageTabs,
  useDockTabsStore,
} from "@/stores/artifact/dock-tabs-store"
import { useChatStore } from "@/stores/chat"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

import {
  DOCK_BROWSER_PANEL_ID,
  activateDockPageTab,
  closeDockPageTab,
  dockPageEngineFor,
  dockSessionScopeKey,
  openDockNewTab,
  openDockPage,
  releaseDockPages,
  resetDockPagesForTests,
  setDockPageEngine,
  startDockPageSync,
  subscribeDockPageLifecycle,
} from "./dock-pages"
import { NEW_TAB_PANEL_ID } from "./session-workbench-scope-key"

const client = localBrowser as unknown as Record<string, jest.Mock>
let pages: BrowserPageSummary[] = []
let nextPage = 0
let emit: (event: LocalBrowserEvent) => void = () => undefined
let stopSync: () => void = () => undefined

function pagesChanged() {
  emit({
    type: "pages.changed",
    sessionId: "shared-1",
    pages: pages.map((page) => ({ ...page })),
    activePageId: pages.find((page) => page.active)?.id ?? null,
  })
}

function addPage(url = "about:blank", active = false): BrowserPageSummary {
  nextPage += 1
  const page = { id: `p${nextPage}`, url, title: "", active }
  if (active) for (const other of pages) other.active = false
  pages.push(page)
  return page
}

const tabs = (sessionId = "s1") => selectPageTabs(useDockTabsStore.getState(), sessionId)
const activeTab = (sessionId = "s1") => selectActivePageTab(useDockTabsStore.getState(), sessionId)
const layout = (sessionId = "s1") =>
  useContextWorkbenchStore.getState().layouts[dockSessionScopeKey(sessionId)]
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  pages = []
  nextPage = 0
  resetSharedLocalBrowserForTests({ createSessionId: () => "shared-1" })
  resetDockPagesForTests()
  client.onEvent.mockImplementation(async (callback) => {
    emit = callback
    return jest.fn()
  })
  client.createSession.mockImplementation(async ({ id }) => {
    addPage("about:blank", true)
    return { id }
  })
  client.closeSession.mockResolvedValue(undefined)
  client.subscribeFrames.mockResolvedValue(jest.fn())
  client.rpc.mockImplementation(async (op: string, payload: Record<string, unknown>) => {
    switch (op) {
      case "browser.pages":
        return pages.map((page) => ({ ...page }))
      case "browser.page.create":
        return { ...addPage("about:blank", payload.activate !== false) }
      case "browser.page.close":
        pages = pages.filter((page) => page.id !== payload.pageId)
        return undefined
      case "browser.navigate": {
        const page = pages.find((entry) => entry.id === payload.pageId)
        if (page) page.url = String(payload.url)
        return { ok: true }
      }
      default:
        return { ok: true }
    }
  })
  useDockTabsStore.setState({ bySession: {} })
  useContextWorkbenchStore.setState({ layouts: {} })
  useArtifactDockLayoutStore.getState().resetLayout()
  useArtifactDockLayoutStore.getState().setDockCollapsed(true)
  useArtifactStore.setState({
    openArtifactIdsBySession: { s1: ["a1"] },
    activeArtifactIdBySession: { s1: "a1" },
  })
  useChatStore.setState({ activeSessionId: "s1", sessions: {} } as never)
  stopSync = startDockPageSync()
})

afterEach(() => stopSync())

describe("dockPageEngineFor", () => {
  it("maps a requested backend onto a tab engine", () => {
    expect(dockPageEngineFor(undefined)).toBe("auto")
    expect(dockPageEngineFor("web-fallback")).toBe("auto")
    expect(dockPageEngineFor("embedded")).toBe("embedded")
    expect(dockPageEngineFor("user-chrome")).toBe("user-chrome")
  })
})

describe("openDockPage", () => {
  it("opens a user's link in a new tab and shows it, parking the artifact", () => {
    const tabId = openDockPage("s1", "https://a.test/")
    expect(tabs()).toEqual([{ id: tabId, url: "https://a.test/", title: "", engine: "auto" }])
    expect(activeTab()?.id).toBe(tabId)
    expect(layout()?.activePanelId).toBe(DOCK_BROWSER_PANEL_ID)
    expect(useArtifactStore.getState().activeArtifactIdBySession.s1).toBeNull()
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: false,
      revealIntent: { panelId: DOCK_BROWSER_PANEL_ID, mode: "wide" },
    })
  })

  it("reuses the tab already on an address unless a new tab is asked for", () => {
    const first = openDockPage("s1", "https://a.test/")
    openDockPage("s1", "https://b.test/")
    expect(openDockPage("s1", "https://a.test/")).toBe(first)
    expect(activeTab()?.id).toBe(first)
    expect(openDockPage("s1", "https://a.test/", { newTab: true })).not.toBe(first)
    expect(tabs()).toHaveLength(3)
  })

  it("puts a page from the New Tab page where that page was", () => {
    const tabId = openDockPage("s1", "https://a.test/", {
      replacing: panelTabKey(NEW_TAB_PANEL_ID),
      currentOrder: [panelTabKey("metadata"), panelTabKey(NEW_TAB_PANEL_ID)],
    })
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([
      panelTabKey("metadata"),
      pageTabKey(tabId!),
    ])
  })

  it("keeps an agent's lightweight request on the lightweight tab", () => {
    openDockPage("s1", "https://a.test/")
    const light = openDockPage("s1", "http://localhost:3000/", {
      source: "agent",
      backend: "embedded",
    })
    expect(tabs().find((tab) => tab.id === light)).toMatchObject({ engine: "embedded" })
    expect(
      openDockPage("s1", "http://localhost:3000/next", { source: "agent", backend: "embedded" })
    ).toBe(light)
    expect(tabs().find((tab) => tab.id === light)?.url).toBe("http://localhost:3000/next")
  })

  it("shows the tab an agent is driving", async () => {
    const agentPage = await ensureOwnerFocusPage("chat:s1")
    pagesChanged()
    const tag = sharedLocalBrowserStore.getState().owned[agentPage].tag
    openDockPage("s1", "https://elsewhere.test/")
    expect(openDockPage("s1", "https://a.test/", { source: "agent" })).toBe(tag)
    expect(openDockPage("s1", "", { source: "agent" })).toBe(tag)
  })

  it("gives an agent with no page a tab its first page then fills", async () => {
    const tabId = openDockPage("s1", "https://a.test/", { source: "agent" })
    await ownedPageEngine("chat:s1").navigate("https://a.test/")
    expect(taggedPage("chat:s1", tabId!)).not.toBeNull()
    pagesChanged()
    expect(tabs()).toHaveLength(1)
  })

  it("shows what is open for an empty address, else the New Tab page", () => {
    expect(openDockPage("s1", "")).toBeNull()
    expect(layout()?.activePanelId).toBe(NEW_TAB_PANEL_ID)
    const tabId = openDockPage("s1", "https://a.test/")
    useContextWorkbenchStore.getState().navigatePanel(dockSessionScopeKey("s1"), "metadata")
    expect(openDockPage("s1", "")).toBe(tabId)
    expect(layout()?.activePanelId).toBe(DOCK_BROWSER_PANEL_ID)
  })
})

describe("a conversation in the background", () => {
  it("lines its agent's page up without taking over the dock on screen", () => {
    const tabId = openDockPage("s2", "https://bg.test/", { source: "agent", reveal: false })
    expect(activeTab("s2")?.id).toBe(tabId)
    expect(layout("s2")?.activePanelId).toBe(DOCK_BROWSER_PANEL_ID)
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: true,
      revealIntent: null,
    })
    // Nothing to show there and nothing opened here either.
    expect(openDockPage("s3", "", { source: "agent", reveal: false })).toBeNull()
    expect(layout("s3")).toBeUndefined()
  })
})

describe("openDockNewTab", () => {
  it("opens a shut dock on the New Tab page, parking the artifact", () => {
    openDockNewTab("s1", dockSessionScopeKey("s1"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(layout()?.activePanelId).toBe(NEW_TAB_PANEL_ID)
    expect(useArtifactStore.getState().activeArtifactIdBySession.s1).toBeNull()
  })
})

describe("closing and switching engines", () => {
  it("closes a tab's page with it, and the browser panel with the last tab", async () => {
    const tabId = openDockPage("s1", "https://a.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    closeDockPageTab("s1", tabId)
    await flush()
    expect(client.rpc).toHaveBeenCalledWith("browser.page.close", {
      sessionId: "shared-1",
      pageId: page.id,
    })
    expect(tabs()).toEqual([])
    expect(layout()?.activatedPanelIds ?? []).not.toContain(DOCK_BROWSER_PANEL_ID)
  })

  it("closes the Chromium page of a tab moved to the lightweight preview, keeping the tab", async () => {
    const tabId = openDockPage("s1", "https://a.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    setDockPageEngine("s1", tabId, "embedded")
    await flush()
    pagesChanged()
    expect(pages.map((entry) => entry.id)).not.toContain(page.id)
    expect(tabs()).toEqual([{ id: tabId, url: "https://a.test/", title: "", engine: "embedded" }])
    // Back to Chromium keeps the tab; its page reopens when shown.
    setDockPageEngine("s1", tabId, "auto")
    expect(tabs()[0].engine).toBe("auto")
  })
})

describe("startDockPageSync", () => {
  it("gives a page an agent opened a tab of its own, and follows its address", async () => {
    await openOwnedPage("chat:z")
    const engine = ownedPageEngine("chat:s1")
    await engine.navigate("https://agent.test/")
    pages.find((page) => page.url === "https://agent.test/")!.title = "Agent"
    pagesChanged()
    expect(tabs()).toEqual([
      expect.objectContaining({ url: "https://agent.test/", title: "Agent", engine: "auto" }),
    ])
  })

  it("never overwrites a remembered address with a blank page still loading", async () => {
    const tabId = openDockPage("s1", "https://remembered.test/")!
    await ensureTaggedPage("chat:s1", tabId)
    pagesChanged()
    expect(tabs()[0].url).toBe("https://remembered.test/")
  })

  it("never remembers Chromium's error page, only an address worth reopening", async () => {
    const tabId = openDockPage("s1", "https://remembered.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    const at = (url: string, title: string) => {
      pages = pages.map((item) => (item.id === page.id ? { ...item, url, title } : item))
      pagesChanged()
    }
    at("chrome-error://chromewebdata/", "cognia.invalid")
    expect(tabs()[0]).toMatchObject({ url: "https://remembered.test/" })
    at("https://moved.test/next", "Next")
    expect(tabs()[0]).toMatchObject({ url: "https://moved.test/next", title: "Next" })
  })

  it("drops the tab of a page that closed by itself, not of one released on purpose", async () => {
    const kept = openDockPage("s1", "https://kept.test/")!
    const gone = openDockPage("s1", "https://gone.test/", { newTab: true })!
    const keptPage = (await ensureTaggedPage("chat:s1", kept)).page
    const gonePage = (await ensureTaggedPage("chat:s1", gone)).page
    pages = pages.filter((page) => page.id !== gonePage.id)
    pagesChanged()
    expect(tabs().map((tab) => tab.id)).toEqual([kept])

    await releaseDockPages("s1")
    pagesChanged()
    expect(pages.map((page) => page.id)).not.toContain(keptPage.id)
    expect(tabs().map((tab) => tab.id)).toEqual([kept])
  })

  it("keeps every tab when the whole session goes away", async () => {
    const tabId = openDockPage("s1", "https://a.test/")!
    await ensureTaggedPage("chat:s1", tabId)
    emit({ type: "session.closed", sessionId: "shared-1" })
    expect(tabs().map((tab) => tab.id)).toEqual([tabId])
  })

  it("moves the tab on screen to the page the agent switched to", async () => {
    const first = openDockPage("s1", "https://one.test/")!
    const second = openDockPage("s1", "https://two.test/", { newTab: true })!
    const one = (await ensureTaggedPage("chat:s1", first)).page
    await ensureTaggedPage("chat:s1", second)
    expect(activeTab()?.id).toBe(second)
    await ownedPageEngine("chat:s1").activatePage(one.id)
    expect(activeTab()?.id).toBe(first)
  })

  it("lets an agent's first page fill a restored tab, but not a lightweight one", async () => {
    const restored = openDockPage("s1", "https://restored.test/")!
    const pageId = await ensureOwnerFocusPage("chat:s1")
    expect(sharedLocalBrowserStore.getState().owned[pageId].tag).toBe(restored)

    const light = openDockPage("s2", "https://light.test/", { backend: "embedded" })!
    const other = await ensureOwnerFocusPage("chat:s2")
    expect(sharedLocalBrowserStore.getState().owned[other].tag).not.toBe(light)
  })
})

describe("subscribeDockPageLifecycle", () => {
  let stopLifecycle: () => void = () => undefined
  afterEach(() => stopLifecycle())

  function setStatus(sessionId: string, status: string) {
    useChatStore.setState(
      (state) =>
        ({
          sessions: { ...state.sessions, [sessionId]: { status } },
        }) as never
    )
  }

  it("closes the pages of a conversation left idle", async () => {
    stopLifecycle = subscribeDockPageLifecycle()
    const tabId = openDockPage("s1", "https://a.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    useChatStore.setState({ activeSessionId: "s2" })
    await flush()
    expect(pages.map((entry) => entry.id)).not.toContain(page.id)
    expect(tabs("s1").map((tab) => tab.id)).toEqual([tabId])
  })

  it("waits for a running conversation to settle, if it is still in the background", async () => {
    stopLifecycle = subscribeDockPageLifecycle()
    const tabId = openDockPage("s1", "https://a.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    setStatus("s1", "streaming")
    useChatStore.setState({ activeSessionId: "s2" })
    await flush()
    expect(pages.map((entry) => entry.id)).toContain(page.id)
    setStatus("s1", "awaiting_approval")
    await flush()
    expect(pages.map((entry) => entry.id)).toContain(page.id)
    setStatus("s1", "idle")
    await flush()
    expect(pages.map((entry) => entry.id)).not.toContain(page.id)
  })

  it("keeps a running conversation's pages when the user comes back first", async () => {
    stopLifecycle = subscribeDockPageLifecycle()
    const tabId = openDockPage("s1", "https://a.test/")!
    const { page } = await ensureTaggedPage("chat:s1", tabId)
    setStatus("s1", "streaming")
    useChatStore.setState({ activeSessionId: "s2" })
    useChatStore.setState({ activeSessionId: "s1" })
    setStatus("s1", "idle")
    await flush()
    expect(pages.map((entry) => entry.id)).toContain(page.id)
  })
})

describe("activateDockPageTab", () => {
  it("shows the browser panel on that tab", () => {
    const first = openDockPage("s1", "https://one.test/")!
    openDockPage("s1", "https://two.test/")
    activateDockPageTab("s1", first)
    expect(activeTab()?.id).toBe(first)
    expect(layout()?.activePanelId).toBe(DOCK_BROWSER_PANEL_ID)
  })
})
