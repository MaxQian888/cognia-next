/**
 * @jest-environment jsdom
 *
 * Smoke tests for CanvasPanel. Verifies the Spinner replacement (no bare
 * Loader2 anywhere) and the Empty primitive shell on the no-active-document
 * fallback. Monaco itself is mocked — we exercise the surrounding shell.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CanvasPanel } from "./canvas-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

// Capture the most recent ResizeObserver callback so we can fire ticks at will.
// Monaco's container resize handler is set up in an effect; the observer is
// constructed during render after the editor mounts.
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
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

// next/dynamic's default behaviour shows the loader fallback in jsdom while
// the inner promise resolves on a microtask the test runner never flushes. We
// bypass dynamic entirely and have it return the synchronous component so the
// editor surface renders deterministically. The mock also wires the editorRef
// to a stub that records `layout()` calls so the debounce test can assert
// against it.
const mockEditorLayout = jest.fn()
const mockEditorState = {
  value: "",
  selection: null as null | {
    isEmpty: () => boolean
    getStartPosition: () => { lineNumber: number; column: number }
    getEndPosition: () => { lineNumber: number; column: number }
  },
}
const editorStub = {
  getValue: () => mockEditorState.value,
  getSelection: () => mockEditorState.selection,
  getPosition: () => null,
  executeEdits: jest.fn(),
  focus: jest.fn(),
  getModel: () => ({
    getValue: () => mockEditorState.value,
    getValueInRange: () => {
      const selection = mockEditorState.selection
      if (!selection) return ""
      return mockEditorState.value.slice(
        selection.getStartPosition().column - 1,
        selection.getEndPosition().column - 1
      )
    },
    getOffsetAt: (position: { column: number }) => position.column - 1,
  }),
  layout: mockEditorLayout,
  revealLineInCenter: jest.fn(),
  setPosition: jest.fn(),
}
/**
 * `@monaco-editor/react` always calls `onMount(editor, monaco)` with BOTH
 * arguments; the mock used to pass only the editor, so any consumer that
 * registers the app's Monaco theme on mount (ADR-0148) crashed here while
 * working fine in the product. Hand it a namespace stub with the surface the
 * theme sync touches.
 */
const monacoStub = {
  editor: { defineTheme: jest.fn(), setTheme: jest.fn() },
}
type MonacoMockProps = {
  value: string
  onMount?: (editor: unknown, monaco: unknown) => void
}
jest.mock("next/dynamic", () => () => {
  const Mock = (props: MonacoMockProps) => {
    // Fire onMount synchronously so editorRef is populated before the
    // ResizeObserver effect's first tick.
    if (props.onMount) {
      Promise.resolve().then(() => props.onMount?.(editorStub, monacoStub))
    }
    return <div data-testid="monaco-editor-mock" data-value={props.value} />
  }
  return Mock
})
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: (props: MonacoMockProps) => {
    if (props.onMount) {
      Promise.resolve().then(() => props.onMount?.(editorStub, monacoStub))
    }
    return <div data-testid="monaco-editor-mock" data-value={props.value} />
  },
}))

// next-themes calls useTheme which expects a provider; stub it out.
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

// Canvas hooks pull in Monaco namespace types and side-effectful subscriptions
// (keyboard event listeners, async action dispatching). Stub the surface used.
// Mutable so a test can put the panel into a degraded tier (mock-prefixed to
// satisfy jest's out-of-scope factory rule).
const mockPerformanceProfile = {
  current: {
    mode: "standard" as "standard" | "large" | "very-large",
    lineCount: 10,
    charCount: 100,
    outlineRefresh: "eager" as const,
    symbolParseDebounceMs: 500,
    showStickyScroll: true,
    showDegradedModeNotice: false,
  },
}
jest.mock("@/hooks/canvas/use-canvas-monaco-setup", () => ({
  useCanvasMonacoSetup: () => ({
    settings: { theme: "vs" },
    editorOptions: {},
    onMount: jest.fn(),
    performanceProfile: mockPerformanceProfile.current,
  }),
}))
// Mutable so individual tests can surface an action error (mock-prefixed to
// satisfy jest's out-of-scope factory rule).
const mockActionsState = { running: false, error: null as string | null, runResult: "" }
jest.mock("@/hooks/canvas/use-canvas-actions", () => ({
  useCanvasActions: () => ({
    run: jest.fn(() => Promise.resolve(mockActionsState.runResult)),
    running: mockActionsState.running,
    error: mockActionsState.error,
  }),
}))
jest.mock("@/hooks/canvas/use-canvas-suggestions", () => ({
  useCanvasSuggestions: () => ({ generate: jest.fn(), running: false }),
}))
jest.mock("@/hooks/canvas/use-canvas-keyboard-shortcuts", () => ({
  useCanvasKeyboardShortcuts: () => undefined,
}))
jest.mock("@/components/document/document-format-toolbar", () => ({
  DocumentFormatToolbar: () => <div data-testid="format-toolbar" />,
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))
// Keep the sandboxed preview stack out of the panel smoke tests.
jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { type: string } }) => (
    <div data-testid="mock-artifact-preview" data-type={artifact.type} />
  ),
}))

// Viewport switch + the CM6 light editor (needs DOM-measure shims in jsdom —
// stub it with a textarea honouring the same value/onChange contract).
const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="light-code-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

function resetStore() {
  act(() => {
    const docs = Object.keys(useArtifactStore.getState().canvasDocuments)
    docs.forEach((id) => useArtifactStore.getState().deleteCanvasDocument(id))
    useArtifactStore.getState().setActiveCanvas(null)
  })
}

describe("CanvasPanel", () => {
  beforeEach(() => {
    window.localStorage.clear()
    mobileRef.current = false
    mockActionsState.running = false
    mockActionsState.error = null
    mockActionsState.runResult = ""
    mockEditorState.value = ""
    mockEditorState.selection = null
    mockPerformanceProfile.current = {
      mode: "standard",
      lineCount: 10,
      charCount: 100,
      outlineRefresh: "eager",
      symbolParseDebounceMs: 500,
      showStickyScroll: true,
      showDegradedModeNotice: false,
    }
    editorStub.executeEdits.mockClear()
    act(() => {
      useCanvasSettingsStore.getState().resetSettings()
    })
    resetStore()
  })

  function seedActiveDoc() {
    act(() => {
      const id = useArtifactStore.getState().createCanvasDocument({
        title: "Doc",
        content: "x",
        language: "javascript",
        type: "code",
      })
      useArtifactStore.getState().setActiveCanvas(id)
    })
  }

  it("renders the Empty primitive when no document is active", () => {
    const { container } = renderWithProviders(<CanvasPanel />)
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-description"]')).toBeInTheDocument()
  })

  it("uses the Spinner primitive (not a bare Loader2) for the loading indicator", () => {
    // EditorLoading fires inside <Suspense> when a doc is active and Monaco is
    // still loading. Render the loading component directly via its named
    // export — re-export not provided, so mount via the no-doc path and check
    // that the file does not import Loader2 anywhere.
    const src = readFileSync(join(__dirname, "canvas-panel.tsx"), "utf8")
    expect(src).not.toMatch(/from "lucide-react"\)?[^\n]*Loader2/)
    expect(src).not.toMatch(/<Loader2\b/)
    expect(src).toMatch(/<Spinner\b/)
  })

  it("renders the Monaco editor mock when an active document exists", () => {
    act(() => {
      const id = useArtifactStore.getState().createCanvasDocument({
        title: "Active",
        content: "console.log(1)",
        language: "javascript",
        type: "code",
      })
      useArtifactStore.getState().setActiveCanvas(id)
    })
    renderWithProviders(<CanvasPanel />)
    expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument()
  })

  it("renders the light editor instead of Monaco on mobile and routes edits to the store", () => {
    mobileRef.current = true
    let id = ""
    act(() => {
      id = useArtifactStore.getState().createCanvasDocument({
        title: "Mobile",
        content: "hello",
        language: "markdown",
        type: "text",
      })
      useArtifactStore.getState().setActiveCanvas(id)
    })
    renderWithProviders(<CanvasPanel />)
    expect(screen.getByTestId("light-code-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco-editor-mock")).not.toBeInTheDocument()
    act(() => {
      fireEvent.change(screen.getByTestId("light-code-editor"), {
        target: { value: "hello world" },
      })
    })
    expect((useArtifactStore.getState().canvasDocuments[id] as { content: string }).content).toBe(
      "hello world"
    )
  })

  describe("accessibility wiring", () => {
    it("announces action errors as an assertive alert region when enabled", () => {
      mockActionsState.error = "boom"
      seedActiveDoc()
      renderWithProviders(<CanvasPanel />)
      const alert = screen.getByRole("alert")
      expect(alert).toHaveTextContent("boom")
      expect(alert).toHaveAttribute("aria-live", "assertive")
    })

    it("drops the alert role when announceErrors is disabled", () => {
      act(() => {
        const store = useCanvasSettingsStore.getState()
        store.updateSettings({
          accessibility: { ...store.settings.accessibility, announceErrors: false },
        })
      })
      mockActionsState.error = "boom"
      seedActiveDoc()
      renderWithProviders(<CanvasPanel />)
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.getByText("boom")).toBeInTheDocument()
    })
  })

  describe("preview / review / export wiring", () => {
    function seedDoc(language: "markdown" | "javascript", content = "x") {
      let id = ""
      act(() => {
        id = useArtifactStore.getState().createCanvasDocument({
          title: "Doc",
          content,
          language,
          type: language === "markdown" ? "text" : "code",
        })
        useArtifactStore.getState().setActiveCanvas(id)
      })
      return id
    }

    it("shows the view-mode toggle and preview pane for a previewable document in split mode", () => {
      seedDoc("markdown")
      renderWithProviders(<CanvasPanel />)
      expect(screen.getByTestId("canvas-view-mode-toggle")).toBeInTheDocument()
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument()
      expect(screen.getByTestId("mock-artifact-preview")).toBeInTheDocument()
    })

    it("hides the toggle for a non-previewable document (code-only)", () => {
      seedDoc("javascript")
      renderWithProviders(<CanvasPanel />)
      expect(screen.queryByTestId("canvas-view-mode-toggle")).not.toBeInTheDocument()
      expect(screen.queryByTestId("mock-artifact-preview")).not.toBeInTheDocument()
    })

    it("renders the review view and a reviewing indicator when a proposal is open", () => {
      const id = seedDoc("javascript")
      act(() => {
        useArtifactStore.getState().proposeCanvasReview(id, "IMPROVED\nCODE")
      })
      renderWithProviders(<CanvasPanel />)
      expect(screen.getByTestId("canvas-review-view")).toBeInTheDocument()
      expect(screen.getByText("Reviewing changes")).toBeInTheDocument()
      // The toggle is replaced by the reviewing indicator.
      expect(screen.queryByTestId("canvas-view-mode-toggle")).not.toBeInTheDocument()
    })

    it("moves export out of the editor toolbar into the Context Workbench", () => {
      seedDoc("markdown")
      renderWithProviders(<CanvasPanel />)
      expect(screen.queryByTestId("canvas-export-trigger")).not.toBeInTheDocument()
    })

    it("closing a tab removes the document from the store", () => {
      let idA = ""
      let idB = ""
      act(() => {
        idA = useArtifactStore.getState().createCanvasDocument({
          title: "Alpha",
          content: "a",
          language: "markdown",
          type: "text",
        })
        idB = useArtifactStore.getState().createCanvasDocument({
          title: "Beta",
          content: "b",
          language: "markdown",
          type: "text",
        })
        useArtifactStore.getState().setActiveCanvas(idB)
      })
      renderWithProviders(<CanvasPanel />)
      // Tabs (with close buttons) render when >1 document exists.
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /Close Alpha/i }))
      })
      expect(useArtifactStore.getState().canvasDocuments[idA]).toBeUndefined()
      expect(useArtifactStore.getState().canvasDocuments[idB]).toBeDefined()
    })

    it("moves the language selector out of the editor toolbar into Inspect", () => {
      seedDoc("javascript")
      renderWithProviders(<CanvasPanel />)
      expect(screen.queryByTestId("canvas-language-select")).not.toBeInTheDocument()
    })

    it("reduces the toolbar to direct save and command actions", () => {
      // The AI action menu and the format toolbar moved into the workbench's
      // `ai-actions` / `properties` panels; the editor toolbar keeps only the
      // two actions that belong beside the caret.
      seedDoc("markdown")
      renderWithProviders(<CanvasPanel />)

      expect(screen.getByRole("button", { name: /Save version/i })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Command palette/i })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /More actions/i })).not.toBeInTheDocument()
      expect(screen.queryByTestId("format-toolbar")).not.toBeInTheDocument()
    })

    it("reveals the line in Monaco when a canvas-goto-line event arrives", async () => {
      editorStub.revealLineInCenter.mockClear()
      editorStub.setPosition.mockClear()
      editorStub.focus.mockClear()
      seedDoc("javascript")
      renderWithProviders(<CanvasPanel />)
      // Let the Monaco mock attach editorStub via onMount.
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        window.dispatchEvent(new CustomEvent("canvas-goto-line", { detail: { line: 3 } }))
      })
      expect(editorStub.revealLineInCenter).toHaveBeenCalledWith(3)
      expect(editorStub.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 1 })
      expect(editorStub.focus).toHaveBeenCalled()
    })

    it("ignores a malformed canvas-goto-line event without throwing", async () => {
      editorStub.revealLineInCenter.mockClear()
      seedDoc("javascript")
      renderWithProviders(<CanvasPanel />)
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        window.dispatchEvent(new CustomEvent("canvas-goto-line", { detail: {} }))
      })
      expect(editorStub.revealLineInCenter).not.toHaveBeenCalled()
    })

    it("routes a whole-document AI action into a per-hunk review instead of overwriting", async () => {
      mockActionsState.runResult = "IMPROVED"
      const id = seedDoc("javascript")
      renderWithProviders(<CanvasPanel />)
      // Let the Monaco mock attach editorStub (getSelection → null → whole-doc).
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        window.dispatchEvent(new CustomEvent("canvas-action", { detail: { type: "improve" } }))
        await Promise.resolve()
        await Promise.resolve()
      })
      const review = useArtifactStore.getState().pendingReviews[id]
      expect(review).toBeDefined()
      expect(review.proposedContent).toBe("IMPROVED")
      // The buffer itself is untouched until the review is applied.
      expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("x")
    })

    it("routes a Workbench selection edit into a proposal instead of mutating Monaco", async () => {
      mockActionsState.runResult = "NEW"
      mockEditorState.value = "abc"
      mockEditorState.selection = {
        isEmpty: () => false,
        getStartPosition: () => ({ lineNumber: 1, column: 2 }),
        getEndPosition: () => ({ lineNumber: 1, column: 3 }),
      }
      const id = seedDoc("javascript", "abc")
      renderWithProviders(<CanvasPanel />)
      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("canvas-action", {
            detail: { type: "improve", proposalFirst: true },
          })
        )
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(editorStub.executeEdits).not.toHaveBeenCalled()
      expect(useArtifactStore.getState().pendingReviews[id]?.proposedContent).toBe("aNEWc")
      expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("abc")
    })
  })

  describe("ResizeObserver debounce", () => {
    let originalResizeObserver: typeof globalThis.ResizeObserver | undefined

    beforeEach(() => {
      jest.useFakeTimers()
      mockEditorLayout.mockClear()
      ControllableResizeObserver.instances = []
      originalResizeObserver = globalThis.ResizeObserver
      ;(
        globalThis as unknown as { ResizeObserver: typeof ControllableResizeObserver }
      ).ResizeObserver = ControllableResizeObserver
    })

    afterEach(() => {
      jest.useRealTimers()
      ;(
        globalThis as unknown as { ResizeObserver: typeof globalThis.ResizeObserver | undefined }
      ).ResizeObserver = originalResizeObserver
    })

    async function seedDocAndRender() {
      act(() => {
        const id = useArtifactStore.getState().createCanvasDocument({
          title: "Resize",
          content: "x",
          language: "javascript",
          type: "code",
        })
        useArtifactStore.getState().setActiveCanvas(id)
      })
      const utils = renderWithProviders(<CanvasPanel />)
      // Drain the Promise-microtask the Monaco mock uses to attach
      // editorStub via onMount. Fake timers don't flush microtasks via
      // advanceTimersByTime(0); we need an actual async-act tick.
      await act(async () => {
        await Promise.resolve()
      })
      return utils
    }

    it("registers exactly one ResizeObserver for the editor container", async () => {
      await seedDocAndRender()
      expect(ControllableResizeObserver.instances.length).toBe(1)
    })

    it("coalesces 5 rapid ticks into a single layout() call after the 60ms window", async () => {
      await seedDocAndRender()
      const observer = ControllableResizeObserver.instances[0]!

      act(() => {
        observer.fire()
        observer.fire()
        observer.fire()
        observer.fire()
        observer.fire()
      })
      // Within the debounce window, no layout call has flushed yet.
      act(() => {
        jest.advanceTimersByTime(30)
      })
      expect(mockEditorLayout).toHaveBeenCalledTimes(0)

      // Crossing the 60ms threshold flushes a single layout call.
      act(() => {
        jest.advanceTimersByTime(40)
      })
      expect(mockEditorLayout).toHaveBeenCalledTimes(1)
    })

    it("cancels the pending layout call when unmounted before the timer fires", async () => {
      const { unmount } = await seedDocAndRender()
      const observer = ControllableResizeObserver.instances[0]!

      act(() => {
        observer.fire()
      })
      act(() => {
        unmount()
      })
      act(() => {
        jest.advanceTimersByTime(200)
      })
      expect(mockEditorLayout).toHaveBeenCalledTimes(0)
    })
  })
  describe("large-document degradation", () => {
    async function seedAndRender() {
      let id = ""
      act(() => {
        id = useArtifactStore.getState().createCanvasDocument({
          title: "Big",
          content: "x",
          language: "javascript",
          type: "code",
        })
        useArtifactStore.getState().setActiveCanvas(id)
      })
      renderWithProviders(<CanvasPanel />)
      await act(async () => {
        await Promise.resolve()
      })
      return id
    }

    it("says nothing for a normal document", async () => {
      await seedAndRender()
      expect(screen.queryByTestId("canvas-performance-notice")).toBeNull()
    })

    it("announces the degraded tier instead of silently dropping editor features", async () => {
      // Monaco quietly losing its minimap and folding on a big file reads as
      // breakage; the notice is what makes it read as a decision.
      mockPerformanceProfile.current = {
        mode: "very-large",
        lineCount: 6000,
        charCount: 400000,
        outlineRefresh: "manual",
        symbolParseDebounceMs: 1500,
        showStickyScroll: false,
        showDegradedModeNotice: true,
      }
      await seedAndRender()
      const notice = screen.getByTestId("canvas-performance-notice")
      expect(notice).toHaveAttribute("data-mode", "very-large")
      // The jest next-intl mock resolves against the real `i18n/messages/en.json`,
      // so this is the shipped copy — including the ICU `{lines, number}` grouping.
      expect(notice).toHaveTextContent("Very large document (6,000 lines)")
    })

    it("stamps the resolved tier onto the document's editor context", async () => {
      mockPerformanceProfile.current = {
        mode: "large",
        lineCount: 2000,
        charCount: 90000,
        outlineRefresh: "deferred",
        symbolParseDebounceMs: 900,
        showStickyScroll: true,
        showDegradedModeNotice: true,
      }
      const id = await seedAndRender()
      expect(useArtifactStore.getState().canvasDocuments[id]?.editorContext?.performanceMode).toBe(
        "large"
      )
    })
  })
})
