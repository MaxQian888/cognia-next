/**
 * Tests for CanvasSidePanels — tab persistence + iconOnly collapse
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT, CanvasSidePanels } from "./canvas-side-panels"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"

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
jest.mock("./comment-panel", () => ({
  CommentPanel: () => <div data-testid="host-comments" />,
}))
jest.mock("./collaboration-panel", () => ({
  CollaborationPanel: () => <div data-testid="host-collab" />,
}))
jest.mock("./code-execution-panel", () => ({
  CodeExecutionPanel: () => <div data-testid="host-execution" />,
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

  it("renders the tab bar with full labels by default (>= 280px)", () => {
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)
    expect(screen.getByRole("tab", { name: /Suggestions/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /History/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Comments/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Collab/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Run/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Outline/i })).toBeInTheDocument()
  })

  it("clicking a tab calls setActiveRightTab", async () => {
    seedDocument("doc-1")
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)
    await user.click(screen.getByRole("tab", { name: /History/i }))
    expect(useCanvasLayoutStore.getState().activeRightTab).toBe("history")
    await user.click(screen.getByRole("tab", { name: /Run/i }))
    expect(useCanvasLayoutStore.getState().activeRightTab).toBe("execution")
    await user.click(screen.getByRole("tab", { name: /Outline/i }))
    expect(useCanvasLayoutStore.getState().activeRightTab).toBe("outline")
  })

  it("starts on the persisted activeRightTab from the store", () => {
    act(() => {
      useCanvasLayoutStore.getState().setActiveRightTab("collaboration")
    })
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)
    const collabTab = screen.getByRole("tab", { name: /Collab/i })
    expect(collabTab).toHaveAttribute("data-state", "active")
  })

  it("collapses to icon-only when ResizeObserver reports width < breakpoint", () => {
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)
    expect(ControllableResizeObserver.instances.length).toBe(1)
    const observer = ControllableResizeObserver.instances[0]
    expect(observer).toBeDefined()
    // First, simulate a wide rail — labels should be visible.
    act(() => {
      observer!.emit(320)
    })
    expect(screen.getByRole("tab", { name: /Suggestions/i })).toBeInTheDocument()
    // Now simulate a narrow rail — labels collapse, but icons + aria-labels remain.
    act(() => {
      observer!.emit(CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT - 30)
    })
    const tab = screen.getByRole("tab", { name: /Suggestions/i })
    // The visible <span> with the textual label is dropped in icon-only mode.
    expect(tab.textContent ?? "").not.toMatch(/Suggestions/i)
  })

  it("pins the icon-only breakpoint export at 280 (regression guard)", () => {
    expect(CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT).toBe(280)
  })

  it("wraps the active tab's host in a motion container", () => {
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)
    // Default tab is "suggestions" — the motion wrapper carries a stable data-testid.
    expect(screen.getByTestId("canvas-tab-motion-suggestions")).toBeInTheDocument()
  })

  it("renders the motion wrapper matching the persisted active tab", () => {
    act(() => {
      useCanvasLayoutStore.getState().setActiveRightTab("history")
    })
    seedDocument("doc-1")
    renderWithProviders(<CanvasSidePanels />)
    expect(screen.getByTestId("canvas-tab-motion-history")).toBeInTheDocument()
  })

  it("does not emit a duplicate-key warning for the AnimatePresence tab panels", async () => {
    // AnimatePresence requires its DIRECT children (the TabsContent panels) to
    // carry unique keys; keying only the inner motion.div produced a
    // "two children with the same key, ``" console error in the desktop shell.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    seedDocument("doc-1")
    const user = userEvent.setup()
    renderWithProviders(<CanvasSidePanels />)
    await user.click(screen.getByRole("tab", { name: /History/i }))
    await user.click(screen.getByRole("tab", { name: /Run/i }))
    const sawDuplicateKey = errorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("same key"))
    )
    expect(sawDuplicateKey).toBe(false)
    errorSpy.mockRestore()
  })
})
