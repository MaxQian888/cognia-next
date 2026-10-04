/** @jest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DockTabStrip, isKnownDockPanel, openDockNewTab, presentDockTabs } from "./dock-tab-strip"
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
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionSelectionIndicator: () => null,
}))

const SESSION = "s1"
const SCOPE = "wb::session:s1"
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
    setPanels(["new-tab", "browser"], "browser")
    setArtifacts(["a1"], null)
    renderStrip()

    expect(screen.getByRole("tablist", { name: "label" })).toBeInTheDocument()
    expect(tabNames()).toEqual(["contextWorkbench.newTab.title", "browser.title", "Report"])
    expect(screen.getByRole("tab", { name: "browser.title" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("shows the artifact in front when one is active, whatever the panel scope says", () => {
    setPanels(["browser"], "browser")
    setArtifacts(["a1"], "a1")
    renderStrip()
    expect(screen.getByRole("tab", { name: "Report" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "browser.title" })).toHaveAttribute(
      "aria-selected",
      "false"
    )
  })

  it("parks the artifact when a panel tab is chosen, keeping its tab", () => {
    setPanels(["browser"], "browser")
    setArtifacts(["a1"], "a1")
    renderStrip()

    fireEvent.click(screen.getByRole("tab", { name: "browser.title" }))

    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("browser")
    // The browser wants room: the dock is asked for it.
    expect(onWidthHint).toHaveBeenCalledWith("wide", "browser")
    expect(screen.getByRole("tab", { name: "Report" })).toBeInTheDocument()
  })

  it("brings an artifact forward from its tab", () => {
    setPanels(["browser"], "browser")
    setArtifacts(["a1", "a2"], null)
    renderStrip()
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }))
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBe("a2")
  })

  it("hands the front to the right-hand neighbour when the active tab closes", () => {
    setPanels(["browser", "workspace"], "browser")
    setArtifacts(["a1"], null)
    renderStrip()

    fireEvent.click(screen.getByRole("button", { name: 'close{"name":"browser.title"}' }))

    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activatedPanelIds).toEqual([
      "workspace",
    ])
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("workspace")
  })

  it("closes an artifact tab through the artifact store", () => {
    setPanels(["browser"], "browser")
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
    setPanels(["browser"], "browser")
    setArtifacts(["a1"], "a1")
    renderStrip()
    fireEvent.click(screen.getByTestId("dock-tab-new"))
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("new-tab")
    expect(useArtifactStore.getState().activeArtifactIdBySession[SESSION]).toBeNull()
  })

  it("keeps the order the user dragged tabs into, across kinds", () => {
    setPanels(["browser"], "browser")
    setArtifacts(["a1"], null)
    renderStrip()
    const report = screen.getByTestId("dock-tab-artifact:a1")
    const browser = screen.getByTestId("dock-tab-panel:browser")
    fireEvent.dragStart(report, { dataTransfer: { effectAllowed: "" } })
    fireEvent.dragOver(browser)
    fireEvent.drop(browser)

    expect(tabNames()).toEqual(["Report", "browser.title"])
    expect(useDockTabsStore.getState().bySession[SESSION].order).toEqual([
      "artifact:a1",
      "panel:browser",
    ])
  })

  it("moves through the tabs from the keyboard, activating as it goes", async () => {
    const user = userEvent.setup()
    setPanels(["new-tab", "browser"], "new-tab")
    setArtifacts(["a1"], null)
    renderStrip()
    screen.getByRole("tab", { name: "contextWorkbench.newTab.title" }).focus()

    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "browser.title" })).toHaveFocus()
    expect(useContextWorkbenchStore.getState().layouts[SCOPE].activePanelId).toBe("browser")

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
    setPanels(["browser", "comments"], "browser")
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
