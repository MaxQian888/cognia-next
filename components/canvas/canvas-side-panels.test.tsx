/**
 * Tests for CanvasSidePanels — tab persistence + iconOnly collapse
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CanvasSidePanels } from "./canvas-side-panels"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

// Stub the heavy host components so the test isolates the tab-bar / store wiring.
jest.mock("./suggestions-panel", () => ({
  SuggestionsPanel: () => <div data-testid="host-suggestions" />,
}))
jest.mock("./version-history-panel", () => ({
  VersionHistoryPanel: () => <div data-testid="host-history" />,
}))
jest.mock("./collaboration-panel", () => ({
  CollaborationPanel: () => <div data-testid="host-collab" />,
}))
jest.mock("./code-execution-panel", () => ({
  CodeExecutionPanel: () => <div data-testid="host-execution" />,
}))
jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: () => <div data-testid="resource-workbench-chat" />,
}))
jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: () => ({ id: "canvas-resource-session" }),
}))
jest.mock("@/stores/canvas/comment-store", () => {
  const store = {
    getCommentsForDocument: () => [],
  }
  return {
    useCommentStore: (selector?: (s: typeof store) => unknown) =>
      selector ? selector(store) : store,
  }
})
jest.mock("@/hooks/canvas", () => ({
  useCanvasCodeExecution: () => ({
    execute: jest.fn(),
    cancel: jest.fn(),
    clear: jest.fn(),
    result: null,
    isExecuting: false,
  }),
}))

class ControllableResizeObserver {
  static instances: ControllableResizeObserver[] = []
  callback: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb
    ControllableResizeObserver.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(width: number) {
    this.callback(
      [{ contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
}

function seedDocument(id: string) {
  act(() => {
    const create = useArtifactStore.getState().createCanvasDocument
    const setActive = useArtifactStore.getState().setActiveCanvas
    const docId = create({
      title: "Doc",
      content: "",
      language: "markdown",
      type: "text",
    })
    setActive(docId)
    // We don't strictly need the returned id; the store now has an active doc.
    void id
    void docId
  })
}

describe("CanvasSidePanels", () => {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver
    ControllableResizeObserver.instances = []
    ;(
      globalThis as unknown as { ResizeObserver: typeof ControllableResizeObserver }
    ).ResizeObserver = ControllableResizeObserver
    window.localStorage.clear()
    act(() => {
      useCanvasLayoutStore.getState().resetLayout()
      useContextWorkbenchStore.setState({ layouts: {} })
      // Wipe any leftover documents from prior test runs.
      const docs = Object.keys(useArtifactStore.getState().canvasDocuments)
      docs.forEach((id) => useArtifactStore.getState().deleteCanvasDocument(id))
      useArtifactStore.getState().setActiveCanvas(null)
    })
  })

  afterEach(() => {
    ;(
      globalThis as unknown as { ResizeObserver: typeof globalThis.ResizeObserver | undefined }
    ).ResizeObserver = originalResizeObserver
  })

  it("shows the empty state when no document is active", () => {
    renderWithProviders(<CanvasSidePanels />)
    expect(
      screen.getByText(/Open a document to see suggestions, history and comments/i)
    ).toBeInTheDocument()
  })

  it("uses the Context Workbench activity rail when the surface flag is enabled", async () => {
    seedDocument("doc-1")
    const activeId = useArtifactStore.getState().activeCanvasId
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /History/i }))
    expect(
      Object.entries(useContextWorkbenchStore.getState().layouts).find(([key]) =>
        key.endsWith(`::canvas:${activeId}`)
      )?.[1].activePanelId
    ).toBe("history")
  })

  it("passes the shell's rail-only state through to the workbench", async () => {
    // The Canvas shell shrinks its own column to the rail; the workbench has to
    // be told, or it keeps drawing a panel body inside a column that is no
    // longer wide enough for one — and reports itself visible to any panel
    // asking, which is what made plugin panels claim visibility while the whole
    // column was closed.
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels railOnly />)

    expect(screen.getByTestId("context-workbench-activity-rail")).toHaveAttribute(
      "data-rail-only",
      "true"
    )
  })

  it("draws the full workbench when the column is not shrunk", async () => {
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)

    expect(screen.getByTestId("context-workbench-activity-rail")).not.toHaveAttribute(
      "data-rail-only"
    )
  })

  it("resets the canvas shell layout from the Context Workbench layout menu", async () => {
    seedDocument("doc-1")
    act(() => {
      useCanvasLayoutStore.setState({
        leftCollapsed: true,
        rightCollapsed: true,
        activeRightTab: "history",
        previewMode: "preview",
      })
    })
    const previousVersion = useCanvasLayoutStore.getState().layoutVersion
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)

    await user.click(screen.getByTestId("context-workbench-layout-menu"))
    await user.click(await screen.findByTestId("context-workbench-reset-layout"))

    expect(useCanvasLayoutStore.getState()).toMatchObject({
      leftCollapsed: false,
      rightCollapsed: false,
      activeRightTab: "suggestions",
      previewMode: "split",
      layoutVersion: previousVersion + 1,
    })
  })

  it("hosts document language and export actions in Inspect and Preview", async () => {
    seedDocument("doc-1")
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)

    await user.click(screen.getByRole("button", { name: /Document properties/i }))
    expect(screen.getByTestId("canvas-language-select")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Preview/i }))
    expect(screen.getByTestId("canvas-export-trigger")).toBeInTheDocument()
  })

  it("dispatches AI and format commands from Workbench panels", async () => {
    seedDocument("doc-1")
    const actionListener = jest.fn()
    const formatListener = jest.fn()
    window.addEventListener("canvas-action", actionListener)
    window.addEventListener("canvas-format", formatListener)
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)

    await user.click(screen.getByRole("tab", { name: /AI actions/i }))
    await user.click(screen.getByRole("button", { name: /^Review$/i }))
    expect(actionListener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: "review", proposalFirst: true } })
    )

    await user.click(screen.getByRole("button", { name: /Document properties/i }))
    await user.click(screen.getByRole("button", { name: "Bold" }))
    expect(formatListener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { action: "bold" } })
    )

    window.removeEventListener("canvas-action", actionListener)
    window.removeEventListener("canvas-format", formatListener)
  })
})
