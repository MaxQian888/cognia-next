/**
 * @jest-environment jsdom
 *
 * Smoke tests for CanvasPanel. Verifies the Spinner replacement (no bare
 * Loader2 anywhere) and the Empty primitive shell on the no-active-document
 * fallback. Monaco itself is mocked — we exercise the surrounding shell.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { act, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CanvasPanel } from "./canvas-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

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
jest.mock("@/hooks/canvas/use-canvas-actions", () => ({
  useCanvasActions: () => ({ run: jest.fn(), running: false, error: null }),
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
    resetStore()
  })

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

    function seedDocAndRender() {
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
      // Drain the microtask the Monaco mock uses to attach editorStub via onMount.
      act(() => {
        jest.advanceTimersByTime(0)
      })
      return utils
    }

    it("registers exactly one ResizeObserver for the editor container", () => {
      seedDocAndRender()
      expect(ControllableResizeObserver.instances.length).toBe(1)
    })

    it("coalesces 5 rapid ticks into a single layout() call after the 60ms window", () => {
      seedDocAndRender()
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

    it("cancels the pending layout call when unmounted before the timer fires", () => {
      const { unmount } = seedDocAndRender()
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
