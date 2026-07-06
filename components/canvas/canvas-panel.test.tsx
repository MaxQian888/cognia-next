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
const editorStub = {
  getValue: () => "",
  getSelection: () => null,
  getPosition: () => null,
  executeEdits: jest.fn(),
  focus: jest.fn(),
  getModel: () => null,
  layout: mockEditorLayout,
}
jest.mock("next/dynamic", () => () => {
  const Mock = (props: { value: string; onMount?: (editor: unknown) => void }) => {
    // Fire onMount synchronously so editorRef is populated before the
    // ResizeObserver effect's first tick.
    if (props.onMount) {
      Promise.resolve().then(() => props.onMount?.(editorStub))
    }
    return <div data-testid="monaco-editor-mock" data-value={props.value} />
  }
  return Mock
})
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: (props: { value: string; onMount?: (editor: unknown) => void }) => {
    if (props.onMount) {
      Promise.resolve().then(() => props.onMount?.(editorStub))
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
jest.mock("@/hooks/canvas/use-canvas-monaco-setup", () => ({
  useCanvasMonacoSetup: () => ({
    settings: { theme: "vs" },
    editorOptions: {},
    onMount: jest.fn(),
  }),
}))
// Mutable so individual tests can surface an action error (mock-prefixed to
// satisfy jest's out-of-scope factory rule).
const mockActionsState = { running: false, error: null as string | null }
jest.mock("@/hooks/canvas/use-canvas-actions", () => ({
  useCanvasActions: () => ({
    run: jest.fn(),
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
})
