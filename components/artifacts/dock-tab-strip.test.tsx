/** @jest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  DockTabStrip,
  drawnDockTabs,
  isKnownDockPanel,
  pageTabLabel,
  presentDockTabs,
} from "./dock-tab-strip"
import { dockSessionScopeKey, openDockNewTab } from "@/lib/artifacts/dock-pages"
import { setLocalChromiumInstalled } from "@/lib/browser/agent-engine"
import { openExternal } from "@/lib/tauri/opener"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionSelectionIndicator: () => null,
}))

const SESSION = "s1"
const SCOPE = dockSessionScopeKey("s1")
const onWidthHint = jest.fn()

function artifact(id: string, title: string) {
  return {
    id,
    sessionId: SESSION,
    messageId: `m-${id}`,
    type: "document",
    title,
    content: "x",
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

function setPanels(activatedPanelIds: string[], activePanelId: string | null) {
  act(() =>
    useContextWorkbenchStore.setState({
      layouts: {
        [SCOPE]: {
          mode: "narrow",
          width: 360,
          panelWidths: {},
          activePanelId,
          userPinned: false,
          activatedPanelIds,
          pendingPanelIds: [],
          lastUsedAt: Date.now(),
          splitPanelId: null,
          splitRatio: 50,
        },
      },
    })
  )
}

function setArtifacts(open: string[], active: string | null) {
  act(() =>
    useArtifactStore.setState({
      artifacts: { a1: artifact("a1", "Report"), a2: artifact("a2", "Notes") } as never,
      openArtifactIdsBySession: { [SESSION]: open },
      activeArtifactIdBySession: { [SESSION]: active },
    })
  )
}

function renderStrip() {
  return render(
    <DockTabStrip sessionId={SESSION} sessionScopeKey={SCOPE} onWidthHint={onWidthHint} />
  )
}

function tabNames() {
  return screen.getAllByRole("tab").map((tab) => tab.textContent)
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  useChatStore.setState({ activeSessionId: SESSION })
  useDockTabsStore.setState({ bySession: {} })
  useArtifactDockLayoutStore.getState().resetLayout()
  act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
  useContextWorkbenchStore.setState({ layouts: {} })
  setArtifacts([], null)
})

describe("presentDockTabs", () => {
  it("lists panels, the one in front included, then open artifacts that exist", () => {
    expect(
      presentDockTabs({
        activatedPanelIds: ["browser", "nope"],
        activePanelId: "new-tab",
        openArtifactIds: ["a1", "gone"],
        artifactExists: (id) => id === "a1",
        isKnownPanel: (id) => id !== "nope",
      })
    ).toEqual(["panel:browser", "panel:new-tab", "artifact:a1"])
  })

  it("knows first-party panels and registered plugin panels only", () => {
    expect(isKnownDockPanel("workspace")).toBe(true)
    expect(isKnownDockPanel("not-a-panel")).toBe(false)
  })
})

describe("DockTabStrip", () => {
  it("draws panels and artifacts as one tablist, marking what is in front", () => {
    setPanels(["new-tab", "workspace"], "workspace")
    setArtifacts(["a1"], null)
    renderStrip()

    expect(screen.getByRole("tablist", { name: "label" })).toBeInTheDocument()
    expect(tabNames()).toEqual([
      "contextWorkbench.newTab.title",
      "artifacts.dock.workspaceMode",
      "Report",
    ])
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("shows the artifact in front when one is active, whatever the panel scope says", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1"], "a1")
    renderStrip()
    expect(screen.getByRole("tab", { name: "Report" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toHaveAttribute(
      "aria-selected",
      "false"
    )
  })

  it("parks the artifact when a panel tab is chosen, keeping its tab", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1"], "a1")
    renderStrip()

    fireEvent.click(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" }))

    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("workspace")
    // The browser wants room: the dock is asked for it.
    expect(onWidthHint).toHaveBeenCalledWith("wide", "workspace")
    expect(screen.getByRole("tab", { name: "Report" })).toBeInTheDocument()
  })

  it("brings an artifact forward from its tab", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1", "a2"], null)
    renderStrip()
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }))
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBe("a2")
  })

  it("hands the front to the right-hand neighbour when the active tab closes", () => {
    setPanels(["workspace", "comments"], "workspace")
    setArtifacts(["a1"], null)
    renderStrip()

    fireEvent.click(
      screen.getByRole("button", { name: 'close{"name":"artifacts.dock.workspaceMode"}' })
    )

    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activatedPanelIds).toEqual([
      "comments",
    ])
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("comments")
  })

  it("closes an artifact tab through the artifact store", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1", "a2"], "a1")
    renderStrip()
    // Middle-click, the browser convention.
    fireEvent(
      screen.getByRole("tab", { name: "Report" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 })
    )
    expect(useArtifactStore.getState().openArtifactIdsBySession[SESSION]).toEqual(["a2"])
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBe("a2")
  })

  it("closes the dock with its last tab", () => {
    setPanels(["new-tab"], "new-tab")
    renderStrip()
    fireEvent.click(
      screen.getByRole("button", { name: 'close{"name":"contextWorkbench.newTab.title"}' })
    )
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("opens the New Tab page from +, parking the artifact", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1"], "a1")
    renderStrip()
    fireEvent.click(screen.getByTestId("dock-tab-new"))
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("new-tab")
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
  })

  it("keeps the order the user dragged tabs into, across kinds", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1"], null)
    renderStrip()
    const report = screen.getByTestId("dock-tab-artifact:a1")
    const browser = screen.getByTestId("dock-tab-panel:workspace")
    fireEvent.dragStart(report, { dataTransfer: { effectAllowed: "" } })
    fireEvent.dragOver(browser)
    fireEvent.drop(browser)

    expect(tabNames()).toEqual(["Report", "artifacts.dock.workspaceMode"])
    expect(useDockTabsStore.getState().bySession[SESSION].order).toEqual([
      "artifact:a1",
      "panel:workspace",
    ])
  })

  it("moves through the tabs from the keyboard, activating as it goes", async () => {
    const user = userEvent.setup()
    setPanels(["new-tab", "workspace"], "new-tab")
    setArtifacts(["a1"], null)
    renderStrip()
    screen.getByRole("tab", { name: "contextWorkbench.newTab.title" }).focus()

    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toHaveFocus()
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("workspace")

    await user.keyboard("{End}")
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBe("a1")

    await user.keyboard("{Home}")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("new-tab")
  })

  it("offers referencing and the source jump on an artifact tab", async () => {
    const user = userEvent.setup()
    const jumpToMessage = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage } as never)
    const addContextSelection = jest.fn()
    useChatStore.setState({ addContextSelection } as never)
    setArtifacts(["a1"], "a1")
    renderStrip()

    fireEvent.contextMenu(screen.getByTestId("dock-tab-artifact:a1"))
    await user.click(await screen.findByRole("menuitem", { name: "dock.goToSource" }))
    expect(jumpToMessage).toHaveBeenCalledWith("m-a1", undefined, { align: "center" })

    fireEvent.contextMenu(screen.getByTestId("dock-tab-artifact:a1"))
    await user.click(await screen.findByRole("menuitem", { name: "dock.referenceInChat" }))
    expect(addContextSelection).toHaveBeenCalled()
    useChatViewportStore.setState({ jumpToMessage: null } as never)
  })

  it("marks a panel with something pending", () => {
    setPanels(["workspace", "comments"], "workspace")
    act(() =>
      useContextWorkbenchStore.setState((state) => ({
        layouts: {
          [SCOPE]: { ...state.layouts[SCOPE], pendingPanelIds: ["comments"] },
        },
      }))
    )
    renderStrip()
    expect(
      within(screen.getByTestId("dock-tab-panel:comments")).getByTestId(
        "dock-tab-pending-panel:comments"
      )
    ).toBeInTheDocument()
  })

  it("labels a plugin panel from the registry", () => {
    const unregister = contextPanelRegistry.register({
      id: "plugin-panel",
      activity: "inspect",
      labelKey: "plugin.label",
      label: "Plugin Panel",
      appliesTo: () => true,
      renderer: () => null,
    } as never)
    try {
      setPanels(["plugin-panel"], "plugin-panel")
      renderStrip()
      expect(screen.getAllByRole("tab")).toHaveLength(1)
    } finally {
      if (typeof unregister === "function") unregister()
    }
  })
})

describe("openDockNewTab", () => {
  it("opens a shut dock on the New Tab page", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    setArtifacts(["a1"], "a1")
    act(() => openDockNewTab(SESSION, SCOPE))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("new-tab")
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
  })
})

describe("page tabs", () => {
  function addPage(id: string, url: string, title = "", activate = false) {
    act(() =>
      useDockTabsStore
        .getState()
        .addPageTab(SESSION, { id, url, title, engine: "auto" }, { activate })
    )
  }

  it("labels a page by its title, else its host, else its address", () => {
    expect(pageTabLabel({ title: "Docs", url: "https://a.test/x" })).toBe("Docs")
    expect(pageTabLabel({ title: "", url: "https://a.test/x" })).toBe("a.test")
    expect(pageTabLabel({ title: "", url: "not a url" })).toBe("not a url")
  })

  it("stands page tabs in for the browser panel", () => {
    expect(
      presentDockTabs({
        activatedPanelIds: ["browser", "workspace"],
        activePanelId: "browser",
        openArtifactIds: ["a1"],
        artifactExists: () => true,
        isKnownPanel: () => true,
        pageTabIds: ["pt-1"],
      })
    ).toEqual(["panel:workspace", "artifact:a1", "page:pt-1"])
  })

  it("draws the strip as the dock shows it, pages included", () => {
    setPanels(["browser", "workspace"], "browser")
    addPage("pt-1", "https://a.test/")
    expect(drawnDockTabs(SESSION, SCOPE)).toEqual(["panel:workspace", "page:pt-1"])
  })

  it("draws pages with their icon, the one shown in front", () => {
    setPanels(["browser"], "browser")
    addPage("pt-1", "https://a.test/", "Alpha")
    addPage("pt-2", "http://localhost:5173/", "", true)
    renderStrip()
    expect(tabNames()).toEqual(["Alpha", "localhost:5173"])
    expect(screen.getByRole("tab", { name: "localhost:5173" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.queryByRole("tab", { name: "browser.title" })).toBeNull()
    const icon = screen.getByTestId("dock-tab-page:pt-1").querySelector("img")
    expect(icon).toHaveAttribute("src", "https://a.test/favicon.ico")
  })

  it("shows a page from its tab, asking for room", () => {
    setPanels(["workspace"], "workspace")
    setArtifacts(["a1"], "a1")
    addPage("pt-1", "https://a.test/")
    renderStrip()
    fireEvent.click(screen.getByRole("tab", { name: "a.test" }))
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("browser")
    expect(useDockTabsStore.getState().bySession[SESSION].activePageTabId).toBe("pt-1")
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
    expect(onWidthHint).toHaveBeenCalledWith("wide", "browser")
  })

  it("closes a page tab, and the browser panel with the last one", () => {
    setPanels(["browser", "workspace"], "browser")
    addPage("pt-1", "https://a.test/", "", true)
    renderStrip()
    fireEvent.click(screen.getByRole("button", { name: 'close{"name":"a.test"}' }))
    expect(useDockTabsStore.getState().bySession[SESSION].pages).toEqual([])
    const layout = useContextWorkbenchStore.getState().layouts[SCOPE]
    expect(layout.activatedPanelIds).toEqual(["workspace"])
    expect(layout.activePanelId).toBe("workspace")
  })

  it("moves a page to the lightweight preview from its menu", async () => {
    const user = userEvent.setup()
    setPanels(["browser"], "browser")
    addPage("pt-1", "https://a.test/", "", true)
    renderStrip()
    fireEvent.contextMenu(screen.getByTestId("dock-tab-page:pt-1"))
    await user.click(await screen.findByRole("menuitem", { name: "openInLightweight" }))
    expect(useDockTabsStore.getState().bySession[SESSION].pages[0].engine).toBe("embedded")
    expect(screen.getByTestId("dock-tab-lightweight-page:pt-1")).toBeInTheDocument()
  })

  it("offers Chromium back only where it is installed", async () => {
    const user = userEvent.setup()
    setPanels(["browser"], "browser")
    act(() =>
      useDockTabsStore
        .getState()
        .addPageTab(SESSION, { id: "pt-1", url: "https://a.test/", title: "", engine: "embedded" })
    )
    const view = renderStrip()
    fireEvent.contextMenu(screen.getByTestId("dock-tab-page:pt-1"))
    await screen.findByRole("menuitem", { name: "openInDefaultBrowser" })
    expect(screen.queryByRole("menuitem", { name: "openInChromium" })).toBeNull()
    view.unmount()

    setLocalChromiumInstalled(true)
    try {
      renderStrip()
      fireEvent.contextMenu(screen.getByTestId("dock-tab-page:pt-1"))
      await user.click(await screen.findByRole("menuitem", { name: "openInChromium" }))
      expect(useDockTabsStore.getState().bySession[SESSION].pages[0].engine).toBe("auto")
    } finally {
      setLocalChromiumInstalled(false)
    }
  })

  it("opens a page in the default browser from its menu", async () => {
    const user = userEvent.setup()
    setPanels(["browser"], "browser")
    addPage("pt-1", "https://a.test/", "", true)
    renderStrip()
    fireEvent.contextMenu(screen.getByTestId("dock-tab-page:pt-1"))
    await user.click(await screen.findByRole("menuitem", { name: "openInDefaultBrowser" }))
    expect(openExternal).toHaveBeenCalledWith("https://a.test/")
  })
})
